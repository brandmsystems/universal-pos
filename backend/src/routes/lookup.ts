import type { FastifyRequest } from 'fastify';
import type { RouteDefinition } from '../core/middleware/routeRegistry.js';

export type Handler = RouteDefinition['handler'];

/**
 * ###########################################################################
 * THE ROUTE TABLES NAME THEIR HANDLERS BY STRING, SO THE JOIN IS UNTYPED.
 *
 * `h('addLine')` is a lookup in a `Record<string, Handler>`. A rename on either
 * side does not fail to compile: the route silently falls back to the `ok` stub,
 * and the audit middleware then records `order.line.added` for a request that
 * added nothing. That is the exact failure `UnservedRouteError` exists to catch
 * at boot -- but only for routes the assembly knows are unserved.
 *
 * So every looked-up handler carries the name it was looked up under, and the
 * gate asserts the correspondence in BOTH directions: no handler in the maps
 * that no route asks for, and no route asking for a name the maps do not supply.
 *
 * Tagging lives HERE, in one place, rather than being repeated at the five
 * lookup sites. Five copies of a marker is the same shape as every other list
 * that happens to agree today -- and the fifth copy is the one somebody forgets.
 * ###########################################################################
 */
export const UNSERVED = Symbol('unserved');

/** The `:id` a route acts on, for the audit row's target_id. */
export const pathId = (request: FastifyRequest): string | null => {
  const value = (request.params as Record<string, unknown> | undefined)?.['id'];
  return typeof value === 'string' ? value : null;
};

/** The stub. Reached only when a lookup misses, and marked so the gate can see it. */
const unservedStub: Handler = async () => ({ ok: true });
Object.defineProperty(unservedStub, UNSERVED, { value: true, enumerable: false });

export interface NamedHandler {
  readonly _name?: string;
  readonly [UNSERVED]?: boolean;
}

/**
 * A lookup that tags what it returns.
 *
 * The tag goes on a FRESH function per name, never on the handler taken from the
 * map and never on the shared stub. Tagging the stub in place would give every
 * unserved route whichever name was looked up last, which is worse than no tag:
 * the gate would report a correspondence that does not hold.
 */
export function handlerLookup(
  handlers: Record<string, Handler>,
): (name: string) => Handler {
  return (name) => {
    const impl = handlers[name];
    const target = impl ?? unservedStub;
    const tagged: Handler = async (request, reply, context) =>
      target(request, reply, context);
    Object.defineProperty(tagged, '_name', { value: name, enumerable: false });
    if (impl === undefined) {
      Object.defineProperty(tagged, UNSERVED, { value: true, enumerable: false });
    }
    return tagged;
  };
}

/** The name a route's handler was looked up under, or null if it was not tagged. */
export function handlerName(handler: Handler): string | null {
  const marker = handler as unknown as NamedHandler;
  return typeof marker._name === 'string' ? marker._name : null;
}

/** True when the route table asked for a name the handler map did not supply. */
export function isUnserved(handler: Handler): boolean {
  return (handler as unknown as NamedHandler)[UNSERVED] === true;
}

export class DuplicateHandlerKeyError extends Error {
  readonly code = 'duplicate_handler_key';
  constructor(readonly keys: readonly string[]) {
    super(
      `two handler maps supply the same name: ${keys.join(', ')}. ` +
        'A spread would silently keep the last one and the routes that asked for ' +
        'the first would serve the wrong handler with a 200.',
    );
    this.name = 'DuplicateHandlerKeyError';
  }
}

/**
 * ###########################################################################
 * THE MERGE REFUSES A COLLISION. IT DOES NOT RESOLVE ONE.
 *
 * `{ ...posHandlers(), ...kdsHandlers() }` is how `GET /pos/session/:id/board`
 * served the KITCHEN board for its entire life. Both maps had a `board` key,
 * the spread kept the second, and the POS's single most important read answered
 * `200 []` -- a valid, empty, entirely wrong response. Nothing caught it: the
 * handler existed, the route existed, the correspondence gate saw a name it
 * could resolve, and 662 tests passed. It was found by a screen asking for its
 * own data and getting somebody else's.
 *
 * The lookup is by string, so the compiler cannot help. This can: a duplicate is
 * a boot refusal, in the same class as a route with no audit posture. The cost
 * is that two surfaces may not both call something `board`, which is a small
 * price for a read that cannot be quietly swapped.
 * ###########################################################################
 */
export function mergeHandlers(
  ...maps: readonly Record<string, Handler>[]
): Record<string, Handler> {
  const merged: Record<string, Handler> = {};
  const collisions: string[] = [];
  for (const map of maps) {
    for (const [key, handler] of Object.entries(map)) {
      if (key in merged) collisions.push(key);
      merged[key] = handler;
    }
  }
  if (collisions.length > 0) throw new DuplicateHandlerKeyError([...new Set(collisions)]);
  return merged;
}
