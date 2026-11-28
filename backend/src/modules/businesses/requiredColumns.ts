import type { TenantContext } from '../../database/tenantContext.js';
import type { AdminResource } from './adminResources.js';

/**
 * Which of a resource's writable fields must have a value, read from the
 * table itself: NOT NULL and no default. Derived, never declared -- a list of
 * required fields kept beside the resource declaration would be a second copy
 * of the schema's NOT NULLs, and the first migration that relaxed one would
 * leave a form insisting on a field the database no longer needs.
 *
 * Cached per table for the life of the process: the answer changes only with a
 * migration, and a migration is a deploy.
 */
const cache = new Map<string, ReadonlySet<string>>();

async function notNullWithoutDefault(context: TenantContext, qualified: string): Promise<ReadonlySet<string>> {
  const hit = cache.get(qualified);
  if (hit) return hit;
  const [schema, table] = qualified.split('.');
  const result = await context.client.query<{ column_name: string }>(
    `SELECT column_name
       FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2
        AND is_nullable = 'NO' AND column_default IS NULL AND is_generated = 'NEVER'`,
    [schema, table]);
  const columns = new Set(result.rows.map((row) => row.column_name));
  cache.set(qualified, columns);
  return columns;
}

export async function requiredFields(context: TenantContext, resource: AdminResource): Promise<string[]> {
  const notNull = await notNullWithoutDefault(context, resource.repository().tableName);
  const writable = new Set([...resource.creatable, ...resource.editable]);
  return [...writable].filter((field) => notNull.has(field) && field !== resource.branchColumn);
}
