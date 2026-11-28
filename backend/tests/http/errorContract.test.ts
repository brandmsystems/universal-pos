import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { ERROR_CONTRACT, BOOT_REFUSALS, toErrorResponse } from '../../src/utils/errors/errors.js';

/**
 * Every named refusal is either told to a client or refuses the boot.
 *
 * ###########################################################################
 * THE DOMAIN NAMED 41 REFUSALS AND THE HTTP LAYER THREW ALL OF THEM AWAY.
 *
 * `toErrorResponse` maps a `code` it recognises and answers `500 internal_error,
 * retryable: false` for one it does not. That fallback is correct -- loud and
 * safe beats silently presenting our bug as the caller's mistake -- but it is a
 * fallback, and it was carrying the whole product. `session_version_conflict`,
 * which two waiters at one table produce on the ordinary path, reached a tablet
 * as "internal error, do not retry". So did `line_already_fired`,
 * `menu_item_not_orderable`, `discount_exceeds_authority` and 37 others.
 *
 * Nothing was wrong with any individual error class. The gap was that nothing
 * compared the set of declared codes to the set of mapped ones -- so this gate
 * reads the SOURCE for `readonly code = '...'` rather than an inventory anybody
 * has to remember to update. A new error class fails this test on the commit
 * that introduces it.
 * ###########################################################################
 */

const SRC = path.resolve(import.meta.dirname, '../../src');
const DECLARATION = /readonly code = '([a-z0-9_]+)'/g;

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await walk(full));
    else if (entry.name.endsWith('.ts')) files.push(full);
  }
  return files;
}

async function declaredCodes(): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  for (const file of await walk(SRC)) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(DECLARATION)) {
      found.set(match[1]!, path.relative(SRC, file));
    }
  }
  return found;
}

describe('the error contract is complete by construction', () => {
  it('maps or explicitly boot-lists every code declared in src', async () => {
    const declared = await declaredCodes();
    const unaccounted = [...declared.entries()]
      .filter(([code]) => !(code in ERROR_CONTRACT) && !BOOT_REFUSALS.includes(code))
      .map(([code, file]) => `${code} (${file})`);

    expect(
      unaccounted,
      'these refusals would reach a client as 500 internal_error. Map them in '
        + 'ERROR_CONTRACT with a status and a client action, or add them to '
        + 'BOOT_REFUSALS if the process refuses to start on them',
    ).toEqual([]);
  });

  it('finds a real population, so the walk is not silently reading nothing', async () => {
    const declared = await declaredCodes();
    expect(declared.size).toBeGreaterThan(50);
    // Spot-checks in both buckets, so a bug that put everything in one is visible.
    expect(declared.has('session_version_conflict')).toBe(true);
    expect(declared.has('duplicate_handler_key')).toBe(true);
  });

  it('keeps the two buckets disjoint', () => {
    const both = BOOT_REFUSALS.filter((code) => code in ERROR_CONTRACT);
    expect(both, 'a boot refusal has no client mapping, by definition').toEqual([]);
  });

  it('gives every mapping a status that matches its retryability', () => {
    for (const [code, mapping] of Object.entries(ERROR_CONTRACT)) {
      expect(mapping.clientAction.length, code).toBeGreaterThan(10);
      // A retryable refusal has to be one a retry could plausibly resolve. A
      // retryable 4xx that is not 409 is a contradiction: the request was wrong
      // and sending it again will not make it right.
      if (mapping.retryable) {
        expect([409, 503, 202], `${code} is retryable with status ${mapping.status}`)
          .toContain(mapping.status);
      }
    }
  });

  it('still answers 500 for a code nobody declared, which is the safe fallback', () => {
    const { status, body } = toErrorResponse(
      Object.assign(new Error('invented'), { code: 'not_a_real_code_at_all' }));
    expect(status).toBe(500);
    expect(body.error).toBe('internal_error');
    expect(body.retryable).toBe(false);
  });

  it('answers a constraint violation as a 4xx that names the constraint, not the row',
    () => {
      // What a deferred constraint trigger actually throws: a SQLSTATE, a
      // constraint name, and a message with row values in it.
      const pgError = Object.assign(
        new Error('order line 166bc093-900f-41fb-97bb-7b2b9e5bef4c is allocated 20000bps'),
        { code: '23514', constraint: 'bill_line_invariants' },
      );
      const { status, body } = toErrorResponse(pgError);

      // Not a 500. The schema refusing a write is the domain refusing it.
      expect(status).toBe(409);
      expect(body.error).toBe('invariant_refused');
      expect(body.retryable).toBe(false);
      // The identifier is named; the row is not.
      expect(body.detail).toContain('bill_line_invariants');
      expect(body.detail).not.toContain('166bc093');
    });

  it('names a missing tenant context instead of calling it internal_error', () => {
    // SQLSTATE 28000 from `app.current_tenant_id()`. It stays a 500 -- the caller
    // did nothing wrong -- but it must be NAMED, because this is precisely how
    // POST /tenants failed: the control plane ran on the app pool, every write
    // to an app table was refused with 28000, and it surfaced as a generic
    // internal error while every test passed on an owner pool.
    const { status, body } = toErrorResponse(
      Object.assign(new Error('app.tenant_id is not set: no tenant context for this query'),
        { code: '28000' }));
    expect(status).toBe(500);
    expect(body.error).toBe('tenant_context_missing');
    expect(body.error, 'a generic name here sends someone looking in the wrong place')
      .not.toBe('internal_error');
  });

  it('classifies the other constraint families a client can act on', () => {
    const cases: readonly [string, number, string][] = [
      ['23505', 409, 'already_exists'],
      ['23503', 422, 'reference_invalid'],
      ['23502', 400, 'field_required'],
      ['22P02', 400, 'field_malformed'],
    ];
    for (const [code, status, error] of cases) {
      const result = toErrorResponse(Object.assign(new Error('raw'), { code }));
      expect(result.status, code).toBe(status);
      expect(result.body.error, code).toBe(error);
      expect(result.body.detail, code).not.toContain('raw');
    }
  });

  it('leaves a serialisation failure retryable, which a constraint is not', () => {
    // The two families must not be confused: one says "send it again", the other
    // says "never send that again".
    expect(toErrorResponse(Object.assign(new Error('x'), { code: '40001' })).body.retryable)
      .toBe(true);
    expect(toErrorResponse(Object.assign(new Error('x'), { code: '23514' })).body.retryable)
      .toBe(false);
  });

  it('answers the version conflict as a 409 the queue will not retry', () => {
    const { status, body } = toErrorResponse(
      Object.assign(new Error('moved on'), { code: 'session_version_conflict' }));
    expect(status).toBe(409);
    // The whole reason `retryable` is a field: a queue that retried this would
    // hold the shift's work behind a request that can never succeed.
    expect(body.retryable).toBe(false);
  });
});
