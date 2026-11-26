import type { FastifyRequest } from 'fastify';
import type { RouteDefinition } from '../../core/middleware/routeRegistry.js';
import {
  SetupInvalidError, archiveAddOn, archiveKitchen, createAddOn, createKitchen, createMenuItem, editAddOn, editKitchen,
  editMenuItem, listAddOns, listAtBranch, listKitchens, menuItemDetail, setupProgress,
} from '../../modules/restaurants/setup.js';
import { AdminBranchConflictError } from './admin.js';
import { importSetup } from '../../modules/restaurants/setupImport.js';
import { hasFeature } from '../../modules/platform/entitlements.js';
import { taxClassSplits } from '../../modules/tax/taxSplits.js';
import { setBranchTaxSettings } from '../../modules/tax/branchTaxSettings.js';
import type { SetupSheets } from '@katkitchen/shared';
import {
  issuePrintAgent, listPrintAgents, pollPrintAgent, requestTestPrint, revokePrintAgent,
} from '../../modules/kitchen/printAgent.js';

/**
 * The manager's setup screens: kitchens, add-ons, food items and progress.
 *
 * Not in `adminHandlers()` because those names must be `<resource>.<verb>` for
 * a declared resource -- except `menu/items.create` and `.edit`, which ARE that
 * resource's purpose-built verbs and are supplied here by name.
 */

type Handler = RouteDefinition['handler'];

function body<T>(request: FastifyRequest): T {
  const raw = request.body;
  return (raw !== null && typeof raw === 'object' ? raw : {}) as T;
}

function param(request: FastifyRequest, name: string): string {
  const value = (request.params as Record<string, unknown>)[name];
  if (typeof value !== 'string') throw new Error(`missing path parameter ${name}`);
  return value;
}

/** The verified token's subject; never a body field. */
function subject(request: FastifyRequest): string {
  const sub = (request.claims ?? {})['sub'];
  if (typeof sub !== 'string') throw new Error('no subject on a verified token');
  return sub;
}

/** The session's branch, or the one a branch-less session names -- never another. */
function branch(request: FastifyRequest): string | null {
  const own = (request.claims ?? {})['branch_id'];
  const value = (request.query as Record<string, unknown> | undefined)?.['branchId'];
  const named = typeof value === 'string' && value.length > 0 ? value : null;
  if (typeof own === 'string' && named !== null && named !== own) throw new AdminBranchConflictError();
  return typeof own === 'string' ? own : named;
}

export function setupHandlers(): Record<string, Handler> {
  return {
    // The print agent: listed, issued and revoked by a manager; polled by the agent.
    printAgentList: async (request, _reply, context) => listPrintAgents(context, branch(request)),
    printAgentIssue: async (request, _reply, context) => issuePrintAgent(context, {
      branchId: branch(request), name: body<{ name?: unknown }>(request).name, issuedByUserId: subject(request),
    }),
    printAgentRevoke: async (request, _reply, context) =>
      revokePrintAgent(context, { id: param(request, 'id'), branchId: branch(request), revokedByUserId: subject(request) }),
    printerTestPrint: async (request, _reply, context) =>
      requestTestPrint(context, { printerId: param(request, 'id'), branchId: branch(request) }),
    printAgentPoll: async (request, _reply, context) =>
      pollPrintAgent(context.client, request.printAgent!, body<Record<string, unknown>>(request)),
    setupProgress: async (request, _reply, context) => setupProgress(context, branch(request)),
    // What each tax rate prints as (CGST + SGST, IGST): derived, read only.
    taxSplits: async (_request, _reply, context) => taxClassSplits(context),
    // A branch-scoped session sets its own branch's tax only; the owner's names any.
    branchTaxSettings: async (request, _reply, context) => {
      const id = param(request, 'id');
      const own = (request.claims ?? {})['branch_id'];
      if (typeof own === 'string' && own !== id) throw new AdminBranchConflictError();
      return setBranchTaxSettings(context, id, request.body);
    },

    // The Excel import. Preview and import are the same run; preview always rolls back.
    setupImportPreview: async (request, _reply, context) => importSetup(context, {
      branchId: branch(request), userId: subject(request), sheets: body<{ sheets?: SetupSheets }>(request).sheets ?? {}, apply: false,
      tables: hasFeature(request.entitlement!, 'tables'),
    }),
    setupImport: async (request, _reply, context) => importSetup(context, {
      branchId: branch(request), userId: subject(request), sheets: body<{ sheets?: SetupSheets }>(request).sheets ?? {}, apply: true,
      tables: hasFeature(request.entitlement!, 'tables'),
    }),

    kitchenList: async (request, _reply, context) => listKitchens(context, branch(request)),
    kitchenCreate: async (request, _reply, context) =>
      createKitchen(context, { ...body<Record<string, unknown>>(request), branchId: branch(request) }),
    kitchenEdit: async (request, _reply, context) =>
      editKitchen(context, { ...body<Record<string, unknown>>(request), id: param(request, 'id') }),
    kitchenArchive: async (request, _reply, context) => archiveKitchen(context, param(request, 'id')),

    addOnList: async (_request, _reply, context) => listAddOns(context),
    addOnCreate: async (request, _reply, context) => createAddOn(context, body(request)),
    addOnEdit: async (request, _reply, context) =>
      editAddOn(context, { ...body<Record<string, unknown>>(request), id: param(request, 'id') }),
    addOnArchive: async (request, _reply, context) => archiveAddOn(context, param(request, 'id')),

    menuItemDetail: async (request, _reply, context) => menuItemDetail(context, param(request, 'id')),
    'menu/items.create': async (request, _reply, context) =>
      createMenuItem(context, {
        ...body<Record<string, unknown>>(request),
        branchId: branch(request),
      }),
    'menu/items.edit': async (request, _reply, context) =>
      editMenuItem(context, { ...body<Record<string, unknown>>(request), id: param(request, 'id') }),
    menuItemListing: async (request, _reply, context) => {
      const branchId = branch(request);
      const listed = body<{ listed?: unknown }>(request).listed;
      if (branchId === null || typeof listed !== 'boolean') {
        throw new SetupInvalidError('send { "listed": true | false } and a branch.');
      }
      return listAtBranch(context, {
        itemId: param(request, 'id'), branchId, listed,
      });
    },
  };
}
