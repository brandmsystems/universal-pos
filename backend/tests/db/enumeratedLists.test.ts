import { beforeAll, describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import pg from 'pg';
import { ownerClient, assertCheckedSet } from '../helpers/db.js';

/**
 * ###########################################################################
 * THE STANDING CHECK FOR HAND-WRITTEN LISTS OF SCHEMA NAMES.
 *
 * Three instances of the same habit, in three different layers:
 *   - OWNER_WITHHELD, production code: a copy of the separation rules' keys.
 *   - the APP_TABLE regex, a security gate: a copy of the derived APP_TABLES.
 *   - fixture teardown, test scaffolding: a copy of everything referencing tenant.
 *
 * All three agreed with their source on the day they were written and would have
 * diverged silently. A CLAUDE.md line has not stopped it three times, so it gets
 * a test.
 *
 * ####################### WHY THIS IS NARROW ###############################
 * The blanket version -- "find every hand-written list of names" -- is too broad
 * to be useful, and I would rather say so than ship a check nobody trusts:
 *
 *   - `assertCheckedSet({ mustInclude: [...] })` is a hand-written list of real
 *     table and permission names BY DESIGN. It is the project's non-vacuity
 *     mechanism, and the testing standard requires it. A check that flags it
 *     flags the correct answer.
 *   - Lists of enum VALUES ('void', 'comp', 'discount') look identical to lists
 *     of names but are closed sets fixed by a CHECK constraint.
 *   - Every SQL string in the tree contains table names. Distinguishing "a query"
 *     from "a list used as a predicate" needs a parser, not a regex.
 *
 * So it is scoped to what actually went wrong: **a literal array in `src/`
 * containing three or more real schema-qualified table names.** Production code
 * enumerating tables is precisely the APP_TABLE and teardown failure, and the
 * escape hatch is a justification comment naming why the list is hand-written.
 * ###########################################################################
 */

const MINIMUM_JUSTIFICATION = 40;
const THRESHOLD = 3;

/** Marks a list as deliberately hand-written; the words after it are the reason. */
const JUSTIFICATION = /ENUMERATED-LIST-OK:\s*(.+)/;

let realTables: Set<string>;

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly tables: readonly string[];
  readonly reason: string;
}

function sourceFiles(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = `${dir}/${entry}`;
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/**
 * A literal array of string literals, on one line or several, holding table
 * names. Deliberately not a parser: the point is to catch a habit, and anything
 * this misses is caught by the review question it replaces.
 */
function findEnumeratedLists(file: string, source: string): readonly Finding[] {
  const findings: Finding[] = [];
  const lines = source.split('\n');

  for (const match of source.matchAll(/\[([^[\]]*?)\]/gs)) {
    const body = match[1]!;
    const names = [...body.matchAll(/['"`]([a-z_]+\.[a-z_]+)['"`]/g)].map((m) => m[1]!);
    const known = [...new Set(names)].filter((n) => realTables.has(n));
    if (known.length < THRESHOLD) continue;

    const lineNo = source.slice(0, match.index).split('\n').length;
    // The justification may sit on the declaration or in the comment block above
    // it, so a window is searched rather than a single line.
    const window = lines.slice(Math.max(0, lineNo - 12), lineNo + 2).join('\n');
    const justified = JUSTIFICATION.exec(window);

    if (!justified || justified[1]!.trim().length < MINIMUM_JUSTIFICATION) {
      findings.push({
        file, line: lineNo, tables: known,
        reason: justified
          ? `justification is too short to be one (${justified[1]!.trim().length} chars)`
          : 'no ENUMERATED-LIST-OK justification',
      });
    }
  }
  return findings;
}

beforeAll(async () => {
  const owner: pg.Client = ownerClient();
  await owner.connect();
  try {
    const result = await owner.query<{ name: string }>(
      `SELECT table_schema || '.' || table_name AS name
         FROM information_schema.tables
        WHERE table_schema IN ('app', 'platform') AND table_type = 'BASE TABLE'`,
    );
    realTables = new Set(result.rows.map((r) => r.name));
  } finally {
    await owner.end();
  }
});

describe('hand-written lists of schema names are derived or justified', () => {
  it('knows what the real tables are, from the schema and not from a list', () => {
    // The check itself must not contain the copy it exists to forbid.
    assertCheckedSet({
      label: 'live schema tables',
      checked: [...realTables],
      minimum: 70,
      mustInclude: ['app.order_line', 'app.stock_movement', 'platform.outbox',
                    'platform.usage_counter', 'app.tenant_audit_log'],
    });
  });

  it('catches an unjustified list, and accepts a justified one', () => {
    const offending = `const TABLES = ['app.order_line', 'app.bill_line', 'app.tender'];`;
    expect(findEnumeratedLists('fake.ts', offending)).toHaveLength(1);

    const justified =
      `// ENUMERATED-LIST-OK: these five are measured for the storage metric and\n` +
      `// the choice of WHICH tables to measure is a deliberate judgement.\n` +
      `const TABLES = ['app.order_line', 'app.bill_line', 'app.tender'];`;
    expect(findEnumeratedLists('fake.ts', justified)).toEqual([]);

    // A justification that says nothing is not a justification.
    const hollow =
      `// ENUMERATED-LIST-OK: needed\n` +
      `const TABLES = ['app.order_line', 'app.bill_line', 'app.tender'];`;
    expect(findEnumeratedLists('fake.ts', hollow)).toHaveLength(1);
  });

  it('ignores a list below the threshold and a list of non-tables', () => {
    expect(findEnumeratedLists('fake.ts',
      `const X = ['app.order_line', 'app.bill_line'];`)).toEqual([]);
    // Enum VALUES are a closed set fixed by a CHECK, not a copy of the schema.
    expect(findEnumeratedLists('fake.ts',
      `const KINDS = ['void', 'comp', 'discount', 'recall'];`)).toEqual([]);
  });

  it('finds none in src/', () => {
    const findings = sourceFiles('src').flatMap((f) =>
      findEnumeratedLists(f, readFileSync(f, 'utf8')));

    expect(
      findings.map((f) => `${f.file}:${f.line} [${f.tables.join(', ')}] -- ${f.reason}`),
      'a hand-written list of table names in production code is the OWNER_WITHHELD habit. ' +
        'Derive it from the schema, or mark it ENUMERATED-LIST-OK with a real reason.',
    ).toEqual([]);
  });
});
