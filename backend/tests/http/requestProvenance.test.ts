import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * What a handler is allowed to take from the request body.
 *
 * ###########################################################################
 * THE BODY IS THE ONE PART OF A REQUEST NOBODY VERIFIED.
 *
 * The token is signed. The lease is a row. The route parameters are matched
 * against a route the registrar registered. The body is whatever the caller
 * typed, and three handlers were reading their own ATTRIBUTION out of it:
 *
 *   generateBill    branchId, sessionId, businessDate AND generatedByUserId
 *   tender          tenderedByUserId
 *   settleManual    tenderedByUserId
 *
 * A bill and a tender are the documents a till-shortfall investigation reads.
 * The tenant audit log was always correct -- the registrar takes the actor from
 * the token -- so the discrepancy would have been between the audit trail and
 * the money rows, discovered by someone trying to work out who was on the till.
 *
 * It reached three handlers because `body<Parameters<typeof f>[1]>` is a
 * plausible-looking way to avoid restating a type, and what it actually says is
 * "the client supplies every argument". So this gate reads the type argument of
 * every `body<...>` in the handler layer and refuses the fields that name a
 * verified fact.
 *
 * THIRD_PARTY_ATTRIBUTION is the escape hatch, and it is deliberately narrow: a
 * field naming SOMEBODY ELSE is legitimate and cannot come from the token.
 * `recordManualSettlement` has two people in it -- the cashier keying it in and
 * the manager who authorised it -- and only the first is the caller.
 * ###########################################################################
 */

const HANDLERS = path.resolve(import.meta.dirname, '../../src/routes/handlers');

/** Facts the request already establishes, verified, before the body is read. */
const VERIFIED_ELSEWHERE: readonly { field: string; source: string }[] = [
  { field: 'branchId', source: 'branchOf(request) -- the verified token' },
  { field: 'sessionId', source: 'leasedSession(request) -- the resolved lease row' },
  { field: 'businessDate', source: 'currentBusinessDate(context, branchId)' },
  { field: 'tenantId', source: 'context.tenantId -- the transaction GUC' },
];

/**
 * Fields that name a person OTHER than the caller. Each one is a real second
 * party in the domain, not a convenience.
 */
const THIRD_PARTY_ATTRIBUTION: Readonly<Record<string, string>> = {
  authorisedByUserId:
    'the manager who authorised an out-of-band settlement, who is by definition not the cashier keying it in',
};

/**
 * The pre-auth surface, where there is nothing verified to take a branch from.
 *
 * `POST /api/auth/:slug/pin` reads `branchId` from the body because at that
 * moment there is no token -- that is the entire reason `resolveTenantForAuth`
 * exists. It is a CROSS-CHECK rather than a scope: `authenticatePin` refuses a
 * branch the device is not enrolled at, so a caller naming another branch gets
 * a rejection, not access to it.
 *
 * The exemption is only safe while these handlers serve nothing but the public
 * plane, and the last test in this file asserts exactly that rather than
 * trusting the filename.
 */
const PRE_AUTH_HANDLER_FILES: readonly string[] = ['auth.ts'];

/** Any `...ByUserId` field is attribution; these are the permitted ones. */
const ACTOR_FIELD = /\b([a-zA-Z]*ByUserId)\b/g;

async function handlerSources(): Promise<{ file: string; source: string }[]> {
  const entries = await readdir(HANDLERS);
  return Promise.all(entries
    .filter((name) => name.endsWith('.ts'))
    .map(async (name) => ({
      file: name,
      source: await readFile(path.join(HANDLERS, name), 'utf8'),
    })));
}

/**
 * The type argument of each `body<...>(request)`, brackets balanced so a nested
 * generic (`Omit<Parameters<typeof f>[1], 'x'>`) is captured whole rather than
 * truncated at its first `>`.
 */
function bodyTypeArguments(source: string): string[] {
  const found: string[] = [];
  const marker = 'body<';
  let index = source.indexOf(marker);
  while (index !== -1) {
    let depth = 0;
    let end = index + marker.length - 1;
    for (let i = index + marker.length - 1; i < source.length; i += 1) {
      const char = source[i];
      if (char === '<') depth += 1;
      else if (char === '>') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    found.push(source.slice(index + marker.length, end));
    index = source.indexOf(marker, end);
  }
  return found;
}

describe('a handler does not read verified facts out of the body', () => {
  it('finds the body type arguments it means to check', async () => {
    const sources = await handlerSources();
    const all = sources.flatMap(({ source }) => bodyTypeArguments(source));
    // The declaration `function body<T>(request)` counts, one per file.
    expect(all.length).toBeGreaterThan(20);
    // And the balanced scan really does capture a nested generic whole.
    expect(all.some((t) => t.includes('Omit<') && t.includes('Parameters<'))).toBe(true);
  });

  it('never takes the branch, session, business date or tenant from the body', async () => {
    const offenders: string[] = [];
    for (const { file, source } of await handlerSources()) {
      if (PRE_AUTH_HANDLER_FILES.includes(file)) continue;
      for (const type of bodyTypeArguments(source)) {
        for (const { field, source: from } of VERIFIED_ELSEWHERE) {
          // A word-boundary match on the field name inside the type argument.
          if (new RegExp(`\\b${field}\\b`).test(type)) {
            offenders.push(`${file}: body<...> includes ${field}; take it from ${from}`);
          }
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('never takes the ACTOR from the body, and names the second parties that are', async () => {
    const offenders: string[] = [];
    for (const { file, source } of await handlerSources()) {
      for (const type of bodyTypeArguments(source)) {
        for (const match of type.matchAll(ACTOR_FIELD)) {
          const field = match[1]!;
          // `'x' | 'y'` inside an Omit is a REMOVAL, which is the fix rather
          // than the defect -- those appear after a quote.
          const quoted = new RegExp(`['"]${field}['"]`).test(type);
          if (quoted) continue;
          if (field in THIRD_PARTY_ATTRIBUTION) continue;
          offenders.push(
            `${file}: body<...> includes ${field}. Take it from actorId(context, request), ` +
            'or add it to THIRD_PARTY_ATTRIBUTION with the reason it names somebody else',
          );
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('proves the check would catch the defect it was written for', () => {
    // THE SYNTHETIC VIOLATION: the exact shape the three handlers had.
    const shape = 'body<Parameters<typeof generateBill>[1]>(request)';
    const [type] = bodyTypeArguments(shape);
    expect(type).toBe('Parameters<typeof generateBill>[1]');

    // A hand-written passthrough, which is the same defect spelled out.
    const spelled = "body<{ branchId: string; generatedByUserId: string }>(request)";
    const [spelledType] = bodyTypeArguments(spelled);
    expect(/\bbranchId\b/.test(spelledType!)).toBe(true);
    expect([...spelledType!.matchAll(ACTOR_FIELD)].map((m) => m[1]))
      .toEqual(['generatedByUserId']);
  });

  it('does not flag an Omit that REMOVES the actor, which is the fix', () => {
    const fixed =
      "body<Omit<Parameters<typeof recordTender>[1], 'billId' | 'tenderedByUserId'>>(request)";
    const [type] = bodyTypeArguments(fixed);
    const flagged = [...type!.matchAll(ACTOR_FIELD)]
      .map((m) => m[1]!)
      .filter((field) => !new RegExp(`['"]${field}['"]`).test(type!));
    expect(flagged).toEqual([]);
  });

  it('exempts the pre-auth file only while it serves the public plane alone',
    async () => {
      const { authHandlers } = await import('../../src/routes/handlers/auth.js');
      const { allRoutes } = await import('../../src/routes/index.js');
      const { handlerName } = await import('../../src/routes/lookup.js');

      const preAuthNames = new Set(Object.keys(authHandlers('provenance-test-key')));
      expect(preAuthNames.size).toBeGreaterThan(3);

      const escaped = allRoutes(authHandlers('provenance-test-key'))
        .filter((route) => {
          const name = handlerName(route.handler);
          return name !== null && preAuthNames.has(name) && route.plane !== 'public';
        })
        .map((route) => `${route.method} ${route.url} (plane ${route.plane})`);

      // If a pre-auth handler ever serves a tenant-plane route, it has a
      // verified token and the exemption above stops being true.
      expect(
        escaped,
        'these pre-auth handlers serve a non-public route, so they may no longer '
          + 'read branchId from the body -- remove the file from PRE_AUTH_HANDLER_FILES',
      ).toEqual([]);
    });

  it('keeps the third-party list short and reasoned', () => {
    // Every entry is a hole in the gate above, so each one carries why.
    for (const [field, reason] of Object.entries(THIRD_PARTY_ATTRIBUTION)) {
      expect(reason.length, field).toBeGreaterThan(40);
    }
    expect(Object.keys(THIRD_PARTY_ATTRIBUTION).length).toBeLessThanOrEqual(3);
  });
});
