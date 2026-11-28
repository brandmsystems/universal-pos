import type { RouteDefinition } from '../../middleware/routeRegistry.js';
import { describePlan } from '../../modules/platform/entitlements.js';
import { usageNow } from '../../modules/businesses/planUsage.js';

/**
 * What the restaurant's plan includes, for the admin menu.
 *
 * Not in `adminHandlers()` for the reason `crmHandlers()` states: that map's
 * names must be `<resource>.<verb>` for a resource in `ADMIN_RESOURCES`, and a
 * plan is one document per restaurant with no id and no list.
 */

type Handler = RouteDefinition['handler'];

export function planHandlers(): Record<string, Handler> {
  return {
    // The registrar resolved the document for this route (`plan: 'document'`),
    // the same one every gated route is checked against.
    // Plus what is in use now, so a screen can say "3 of 4 users" before a refusal does.
    planEntitlements: async (request, _reply, context) =>
      ({ ...describePlan(request.entitlement!), usage: await usageNow(context) }),
  };
}
