import type pg from 'pg';
import { requireTenantContext } from './tenantContext.js';

/**
 * The primary isolation mechanism. RLS is the backstop; this is the thing that
 * makes forgetting impossible rather than merely detectable.
 *
 * No method accepts a tenant_id. It is read from the context and injected into
 * every predicate and every inserted row, and a tenant_id appearing in caller
 * data is a thrown error rather than a silently ignored field -- a caller passing
 * one is either confused or hostile, and both deserve a stack trace.
 */

export class TenantIdInPayloadError extends Error {
  constructor(table: string) {
    super(
      `tenant_id must never be supplied by a caller (table ${table}). ` +
        'It comes from the verified JWT, via the tenant context.',
    );
    this.name = 'TenantIdInPayloadError';
  }
}

export class UnscopedMutationError extends Error {
  constructor(table: string, operation: string) {
    super(`refusing to ${operation} every row of ${table}: no predicate was supplied`);
    this.name = 'UnscopedMutationError';
  }
}

const IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

function identifier(name: string): string {
  if (!IDENTIFIER.test(name)) throw new Error(`unsafe SQL identifier: ${JSON.stringify(name)}`);
  return `"${name}"`;
}

export type Value = string | number | boolean | Date | null | readonly string[];
export type Predicate = Readonly<Record<string, Value>>;

interface Fragment {
  readonly text: string;
  // Mutable: pg types query values as any[], and callers append bind params.
  readonly params: unknown[];
}

/** Builds `tenant_id = $1 AND col = $2 ...`. tenant_id always leads and is never optional. */
function whereClause(tenantId: string, predicate: Predicate, table: string): Fragment {
  if ('tenant_id' in predicate) throw new TenantIdInPayloadError(table);

  const params: unknown[] = [tenantId];
  const parts = ['"tenant_id" = $1'];

  for (const [column, value] of Object.entries(predicate)) {
    if (value === null) {
      parts.push(`${identifier(column)} IS NULL`);
      continue;
    }
    params.push(value);
    parts.push(`${identifier(column)} = $${params.length}`);
  }

  return { text: parts.join(' AND '), params };
}

export interface FindOptions {
  readonly orderBy?: string;
  readonly direction?: 'ASC' | 'DESC';
  readonly limit?: number;
  readonly offset?: number;
}

export abstract class BaseRepository<TRow extends Record<string, unknown>> {
  /** Schema-qualified, e.g. `app.branch`. Always in schema `app`. */
  protected abstract readonly table: string;

  /** The schema-qualified table, for callers that read its catalogue metadata. */
  get tableName(): string {
    return this.table;
  }

  private context(operation: string): { tenantId: string; client: pg.ClientBase } {
    const context = requireTenantContext(`${operation} on ${this.table}`);
    return { tenantId: context.tenantId, client: context.client };
  }

  private qualified(): string {
    const [schema, name] = this.table.split('.');
    if (!schema || !name) throw new Error(`table must be schema-qualified: ${this.table}`);
    if (schema !== 'app') {
      throw new Error(`BaseRepository is for schema app only; got ${this.table}`);
    }
    return `${identifier(schema)}.${identifier(name)}`;
  }

  async findMany(predicate: Predicate = {}, options: FindOptions = {}): Promise<TRow[]> {
    const { tenantId, client } = this.context('findMany');
    const where = whereClause(tenantId, predicate, this.table);

    let sql = `SELECT * FROM ${this.qualified()} WHERE ${where.text}`;
    if (options.orderBy) {
      sql += ` ORDER BY ${identifier(options.orderBy)} ${options.direction === 'DESC' ? 'DESC' : 'ASC'}`;
    }
    const params = [...where.params];
    if (options.limit !== undefined) {
      params.push(options.limit);
      sql += ` LIMIT $${params.length}`;
    }
    if (options.offset !== undefined) {
      params.push(options.offset);
      sql += ` OFFSET $${params.length}`;
    }

    const result = await client.query<TRow>(sql, params);
    return result.rows;
  }

  async findOne(predicate: Predicate): Promise<TRow | null> {
    const rows = await this.findMany(predicate, { limit: 1 });
    return rows[0] ?? null;
  }

  /**
   * The before-image for an audit row must be taken with a row lock, through the
   * same path the handler writes through.
   *
   * A plain read is not enough: under READ COMMITTED a concurrent transaction can
   * commit between the read and the mutation, and the audit row then records a
   * before-state the mutation never applied to. That is an audit log that is
   * wrong in a way nothing downstream can detect. FOR UPDATE serialises the pair
   * so before/after are genuinely adjacent.
   */
  async findOneForUpdate(predicate: Predicate): Promise<TRow | null> {
    const { tenantId, client } = this.context('findOneForUpdate');
    const where = whereClause(tenantId, predicate, this.table);
    const result = await client.query<TRow>(
      `SELECT * FROM ${this.qualified()} WHERE ${where.text} LIMIT 1 FOR UPDATE`,
      [...where.params],
    );
    return result.rows[0] ?? null;
  }

  async count(predicate: Predicate = {}): Promise<number> {
    const { tenantId, client } = this.context('count');
    const where = whereClause(tenantId, predicate, this.table);
    const result = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ${this.qualified()} WHERE ${where.text}`,
      [...where.params],
    );
    return Number(result.rows[0]?.n ?? '0');
  }

  async insert(values: Readonly<Record<string, Value>>): Promise<TRow> {
    const { tenantId, client } = this.context('insert');
    if ('tenant_id' in values) throw new TenantIdInPayloadError(this.table);

    const columns = ['"tenant_id"'];
    const params: unknown[] = [tenantId];
    const placeholders = ['$1'];

    for (const [column, value] of Object.entries(values)) {
      params.push(value);
      columns.push(identifier(column));
      placeholders.push(`$${params.length}`);
    }

    const result = await client.query<TRow>(
      `INSERT INTO ${this.qualified()} (${columns.join(', ')})
       VALUES (${placeholders.join(', ')}) RETURNING *`,
      params,
    );
    const row = result.rows[0];
    if (!row) throw new Error(`insert into ${this.table} returned no row`);
    return row;
  }

  /**
   * An empty predicate is refused rather than treated as "all rows of this
   * tenant". Whole-table updates are real operations but they must be spelled
   * out, not arrived at by passing an object that happened to be empty.
   */
  async update(predicate: Predicate, values: Readonly<Record<string, Value>>): Promise<TRow[]> {
    const { tenantId, client } = this.context('update');
    if ('tenant_id' in values) throw new TenantIdInPayloadError(this.table);
    if (Object.keys(predicate).length === 0) throw new UnscopedMutationError(this.table, 'update');

    const where = whereClause(tenantId, predicate, this.table);
    const params = [...where.params];
    const assignments: string[] = [];

    for (const [column, value] of Object.entries(values)) {
      params.push(value);
      assignments.push(`${identifier(column)} = $${params.length}`);
    }
    if (assignments.length === 0) throw new Error(`update on ${this.table} sets nothing`);

    const result = await client.query<TRow>(
      `UPDATE ${this.qualified()} SET ${assignments.join(', ')} WHERE ${where.text} RETURNING *`,
      params,
    );
    return result.rows;
  }

  async delete(predicate: Predicate): Promise<number> {
    const { tenantId, client } = this.context('delete');
    if (Object.keys(predicate).length === 0) throw new UnscopedMutationError(this.table, 'delete');

    const where = whereClause(tenantId, predicate, this.table);
    const result = await client.query(
      `DELETE FROM ${this.qualified()} WHERE ${where.text}`,
      [...where.params],
    );
    return result.rowCount ?? 0;
  }
}
