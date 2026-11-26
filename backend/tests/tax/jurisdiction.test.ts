import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type pg from 'pg';
import { ownerClient, appClient, assertCheckedSet } from '../helpers/db.js';
import { JURISDICTIONS } from '../../src/modules/tax/jurisdictions.js';
import {
  headsOf, implementedCodes, implementedJurisdiction, jurisdiction, resolverCodes,
  resolveSupply, splitHeads, headRuleOf, treatmentsOf,
  TaxHeadsMissingError, TaxJurisdictionNotImplementedError,
  TaxJurisdictionUnknownError, TaxTreatmentUnknownError,
} from '../../src/modules/tax/registry.js';

/**
 * The jurisdiction seam.
 *
 * ###########################################################################
 * WHAT THIS FILE IS FOR, IN ONE PARAGRAPH.
 *
 * The owner has settled that this is ONE product for the whole world with India
 * launched first. That makes the interesting case not India but the other one,
 * and the only unacceptable answer for a restaurant in a country nobody has
 * written rules for is to quietly give it India's. It would work. Every bill
 * would add up, the till would balance, and the mistake would be a monthly
 * return filed under a regime the shop is not in -- discovered by an
 * assessment, years of it at once.
 *
 * So the vocabulary is DATA in three places at once: `src/modules/tax/jurisdictions.ts`
 * authors it, `platform.tax_jurisdiction` / `tax_treatment` / `tax_head` hold
 * it for the database trigger to read, and `RESOLVERS` in the registry holds
 * the code. Three copies of one fact is three things that can drift apart, and
 * a seam that drifts is worse than no seam: it looks built.
 *
 * Every assertion below therefore runs in BOTH directions. A row in the
 * database with no definition in code fails; a definition in code with no row
 * fails. A jurisdiction marked `implemented` with no resolver fails; a resolver
 * for a jurisdiction nobody listed fails too.
 * ###########################################################################
 */

let owner: pg.Client;
let app: pg.Client;

beforeAll(async () => {
  owner = ownerClient();
  app = appClient();
  await owner.connect();
  await app.connect();
});

afterAll(async () => {
  await owner.end().catch(() => undefined);
  await app.end().catch(() => undefined);
});

/* ------------------------------------------------------------------ A --- */

describe('A. the catalogue in code and the catalogue in the database are the same catalogue', () => {
  it('holds the same jurisdictions, in both directions', async () => {
    const rows = await owner.query<{
      code: string; name: string; status: string; default_dial_code: string;
    }>(`SELECT code, name, status, default_dial_code
          FROM platform.tax_jurisdiction ORDER BY code`);

    const inDb = rows.rows.map((r) => r.code);
    const inCode = JURISDICTIONS.map((j) => j.code).toSorted();

    assertCheckedSet({
      label: 'platform.tax_jurisdiction',
      checked: inDb,
      minimum: 1,
      mustInclude: ['IN'],
    });
    // BOTH directions. A row with no definition would be read by the app
    // trigger and by nothing else; a definition with no row would be trusted by
    // `splitHeads` and refused at COMMIT.
    expect(inDb, 'rows the code does not define').toEqual(inCode);

    for (const row of rows.rows) {
      const defined = JURISDICTIONS.find((j) => j.code === row.code)!;
      expect({ name: row.name, status: row.status, dial: row.default_dial_code }, row.code)
        .toEqual({ name: defined.name, status: defined.status, dial: defined.dialCode });
    }
  });

  it('holds the same treatments, with the same taxability, in both directions', async () => {
    const rows = await owner.query<{
      jurisdiction_code: string; key: string; name: string; head_rule: string;
    }>(`SELECT jurisdiction_code, key, name, head_rule
          FROM platform.tax_treatment ORDER BY jurisdiction_code, key`);

    assertCheckedSet({
      label: 'platform.tax_treatment',
      checked: rows.rows.map((r) => `${r.jurisdiction_code}.${r.key}`),
      minimum: 4,
      mustInclude: ['IN.intra_state', 'IN.inter_state', 'IN.none', 'IN.unstated'],
    });

    for (const row of rows.rows) {
      const defined = JURISDICTIONS
        .find((j) => j.code === row.jurisdiction_code)!
        .treatments.find((t) => t.key === row.key);
      expect(defined, `${row.jurisdiction_code}.${row.key} is a row with no definition`)
        .toBeDefined();
      expect({ name: row.name, rule: row.head_rule }, row.key)
        .toEqual({ name: defined!.name, rule: defined!.headRule });
    }

    const dbKeys = new Set(rows.rows.map((r) => `${r.jurisdiction_code}.${r.key}`));
    const codeKeys = JURISDICTIONS.flatMap(
      (j) => j.treatments.map((t) => `${j.code}.${t.key}`));
    expect(
      codeKeys.filter((k) => !dbKeys.has(k)),
      'treatments the code defines and the database has never seen; the trigger '
        + 'would refuse a bill the code was happy to write',
    ).toEqual([]);
  });

  it('holds the same heads at the same shares, in both directions', async () => {
    const rows = await owner.query<{
      jurisdiction_code: string; treatment_key: string; name: string;
      share_bps: number; ordinal: number;
    }>(`SELECT jurisdiction_code, treatment_key, name, share_bps, ordinal
          FROM platform.tax_head
         ORDER BY jurisdiction_code, treatment_key, ordinal`);

    assertCheckedSet({
      label: 'platform.tax_head',
      checked: rows.rows.map((r) => `${r.jurisdiction_code}.${r.treatment_key}.${r.name}`),
      minimum: 3,
      mustInclude: [
        'IN.intra_state.CGST', 'IN.intra_state.SGST', 'IN.inter_state.IGST',
      ],
    });

    for (const row of rows.rows) {
      const defined = JURISDICTIONS
        .find((j) => j.code === row.jurisdiction_code)!
        .heads.find((h) => h.treatment === row.treatment_key && h.name === row.name);
      expect(defined, `${row.jurisdiction_code}.${row.treatment_key}.${row.name}`)
        .toBeDefined();
      expect({ share: row.share_bps, ordinal: row.ordinal }, row.name)
        .toEqual({ share: defined!.shareBps, ordinal: defined!.ordinal });
    }

    const dbHeads = new Set(rows.rows.map(
      (r) => `${r.jurisdiction_code}.${r.treatment_key}.${r.name}`));
    const codeHeads = JURISDICTIONS.flatMap(
      (j) => j.heads.map((h) => `${j.code}.${h.treatment}.${h.name}`));
    expect(codeHeads.filter((h) => !dbHeads.has(h)), 'heads defined and not seeded')
      .toEqual([]);
  });

  it('gives every taxable treatment a set of shares that sums to the whole', () => {
    // The invariant `platform.assert_tax_shares_whole` enforces, asserted here
    // against the AUTHOR too -- so a definition that could never be seeded
    // fails on the commit that writes it rather than on the migration.
    let checked = 0;
    for (const j of JURISDICTIONS) {
      for (const t of j.treatments) {
        const heads = headsOf(j.code, t.key);
        if (t.headRule === 'required') {
          expect(heads.length, `${j.code}.${t.key} collects tax and has no head`)
            .toBeGreaterThan(0);
          expect(heads.reduce((a, h) => a + h.shareBps, 0), `${j.code}.${t.key}`)
            .toBe(10000);
          // Ordinals distinct and positive: the remainder is distributed by
          // ordinal, so two heads sharing one would put an odd paisa wherever a
          // sort happened to put them.
          expect(new Set(heads.map((h) => h.ordinal)).size).toBe(heads.length);
        } else {
          // `none` has nothing to collect and `unrecorded` nothing knowable to
          // collect it under. Neither may carry a head row.
          expect(heads, `${j.code}.${t.key} is ${t.headRule} and has heads`).toEqual([]);
        }
        checked += 1;
      }
    }
    expect(checked, 'no treatment was examined at all').toBeGreaterThanOrEqual(4);
  });
});

/* ------------------------------------------------------------------ B --- */

describe('B. an implemented jurisdiction is one with rules, and that is asserted', () => {
  it('has a resolver for every implemented code and a code for every resolver', () => {
    const implemented = [...implementedCodes()].toSorted();
    const resolvers = [...resolverCodes()].toSorted();

    assertCheckedSet({
      label: 'implemented jurisdictions',
      checked: implemented,
      minimum: 1,
      mustInclude: ['IN'],
    });

    // ###################################################################
    // THE RATCHET.
    //
    // Marking a jurisdiction `implemented` without writing its resolver would
    // otherwise reach `resolveSupply`, fail the null check, and be reported as
    // "not implemented" -- correct, and discovered at a till. Writing a
    // resolver without listing the jurisdiction would leave dead code that
    // looks like support.
    //
    // Both directions fail here instead. And the day a second country is added,
    // this is the test that forces the author to confront that
    // `resolveIndianSupply` is India's rule and not a general one.
    // ###################################################################
    expect(resolvers, 'resolvers and implemented jurisdictions must correspond exactly')
      .toEqual(implemented);
  });

  it('resolves India through the registry, not through a direct call', () => {
    expect(resolveSupply('IN', {
      supplierStateCode: '29', placeOfSupplyStateCode: '29', taxChargedMinor: 1000,
    }).treatment).toBe('intra_state');
    expect(resolveSupply('IN', {
      supplierStateCode: '29', placeOfSupplyStateCode: '27', taxChargedMinor: 1000,
    }).treatment).toBe('inter_state');
    expect(resolveSupply('IN', {
      supplierStateCode: '29', placeOfSupplyStateCode: '29', taxChargedMinor: 0,
    }).treatment).toBe('none');
  });

  it('REFUSES every declared jurisdiction rather than falling back on India', () => {
    // ###################################################################
    // THE REFUSAL THIS WHOLE PHASE EXISTS FOR, AND AN HONEST NOTE ABOUT IT.
    //
    // The loop below is VACUOUS TODAY: every jurisdiction in the catalogue is
    // implemented, because there is exactly one. Saying so here rather than
    // dressing the vacuity up as coverage -- a loop over an empty set reports
    // "no violations" forever, which is the failure mode helpers/db.ts exists
    // to guard against.
    //
    // What actually protects the seam today is the ratchet in the previous
    // test: a jurisdiction marked `implemented` with no resolver fails, and a
    // resolver with no jurisdiction fails. This loop is what turns on the day a
    // second country is DECLARED, and it turns on before that country's first
    // bill rather than after it.
    // ###################################################################
    const declared = JURISDICTIONS.filter((j) => j.status === 'declared');
    for (const j of declared) {
      expect(() => implementedJurisdiction(j.code), j.code)
        .toThrow(TaxJurisdictionNotImplementedError);
      expect(() => resolveSupply(j.code, {
        supplierStateCode: null, placeOfSupplyStateCode: null, taxChargedMinor: 100,
      }), j.code).toThrow(TaxJurisdictionNotImplementedError);
    }
    // The catalogue has exactly two statuses and nothing else, so a third value
    // could not slip past both this test and the one above.
    expect(
      JURISDICTIONS.filter((j) => j.status !== 'implemented' && j.status !== 'declared'),
    ).toEqual([]);
    expect(declared.length + implementedCodes().length).toBe(JURISDICTIONS.length);
  });

  it('says the right thing when it refuses, which is most of the value', () => {
    // Constructed directly, because no declared jurisdiction exists to reach it
    // through -- and the MESSAGE is a contract in its own right: whoever reads
    // it has to be able to tell "not built yet" from "not a real code", and has
    // to be told what IS built without going to find out.
    const error = new TaxJurisdictionNotImplementedError({
      code: 'ZQ', name: 'Testland', status: 'declared', dialCode: '999',
      treatments: [{ key: 'domestic', name: 'Domestic supply', headRule: 'required' as const }],
      heads: [{ treatment: 'domestic', name: 'VAT', shareBps: 10000, ordinal: 1 }],
      accounts: ['none', 'vat'], defaultAccount: 'vat', billRounding: 'none',
      currency: 'XTS', locale: 'en-US', timezone: 'UTC',
    });
    expect(error).not.toBeInstanceOf(TaxJurisdictionUnknownError);
    expect(error.message).toContain('Testland');
    expect(error.message).toContain('ZQ');
    expect(error.message, 'the refusal must name what IS implemented').toContain('IN');
    expect(error.message).toMatch(/wrong regime/);
    expect(error.statusCode).toBe(422);
    expect(error.code).toBe('tax_jurisdiction_not_implemented');
  });

  it('tells an unknown code apart from an unbuilt one', () => {
    // Two different questions, two different answers: "we have not built
    // Malaysia yet" is a roadmap question, "MY is not a code we recognise" is a
    // typo, and one code for both sends two readers to one wrong place.
    expect(() => jurisdiction('ZZ')).toThrow(TaxJurisdictionUnknownError);
    expect(() => implementedJurisdiction('ZZ')).toThrow(TaxJurisdictionUnknownError);
    expect(() => jurisdiction('ZZ')).toThrow(/not a tax jurisdiction/);
    // And it says what there IS, so the fix is in the refusal.
    expect(() => jurisdiction('ZZ')).toThrow(/IN/);
  });

  it('refuses a treatment the jurisdiction does not define, rather than answering `none`', () => {
    // `none` is a LAWFUL position a document can be issued under -- an
    // unregistered branch, a composition dealer. Answering an undefined
    // treatment that way is how a typo becomes a nil return.
    expect(() => headRuleOf('IN', 'reverse_charge')).toThrow(TaxTreatmentUnknownError);
    expect(() => headRuleOf('IN', 'reverse_charge')).toThrow(/intra_state/);
    expect(treatmentsOf('IN')).toContain('unstated');
  });

  it('calls `unstated` UNRECORDED and not `none`, which is the distinction', () => {
    // ###################################################################
    // THE DEFECT THIS ASSERTION EXISTS FOR, RECORDED.
    //
    // The first draft of this phase modelled the treatment vocabulary as a
    // boolean -- collects tax, or does not -- and put `unstated` on the second
    // arm. `unstated` is neither: 0050 wrote it onto bills that DID charge tax
    // at a branch with no state code, so there is a real amount and no knowable
    // head. Treating it as "collects no tax" made the database trigger demand
    // those lines carry zero tax, and refused documents that already exist.
    //
    // Asserted here so the boolean cannot come back. It would look tidier and
    // it would refuse 863 live bills.
    // ###################################################################
    expect(headRuleOf('IN', 'unstated')).toBe('unrecorded');
    expect(headRuleOf('IN', 'none')).toBe('none');
    expect(headRuleOf('IN', 'intra_state')).toBe('required');
    // And it is unrecorded in the DATABASE too, which is what the trigger reads.
    // Asserted in block A against the whole catalogue; named here because this
    // one row is the one a future tidy-up would get wrong.
  });
});

/* ------------------------------------------------------------------ C --- */

describe('C. the head split is share-based, and exact for any shares', () => {
  it('sums to the tax exactly, at every rate and amount, including odd ones', () => {
    // ###################################################################
    // WHAT REPLACED THE HALVING, AND WHY IT MATTERS BEYOND INDIA.
    //
    // The old splitter did floor(tax / 2) to SGST and the remainder to CGST,
    // and threw `TaxRateDoesNotHalveError` on an odd rate. Correct for two
    // equal shares and expressible for nothing else -- and 0052 deleted
    // `tax_class_rate_halves` on the strength of this: California's combined
    // 7.25% is 725 basis points, odd, lawful, and refused outright before.
    //
    // 725 IS IN THE SWEEP BELOW. That is the assertion, not the comment.
    // ###################################################################
    const rates = [0, 100, 250, 500, 501, 725, 1000, 1800, 4000, 9999, 10000];
    const amounts = [0, 1, 2, 3, 7, 99, 333, 1001, 12345, 999999, 100000001];
    let checked = 0;
    for (const rateBps of rates) {
      for (const taxMinor of amounts) {
        for (const treatment of ['intra_state', 'inter_state']) {
          const heads = splitHeads('IN', treatment, taxMinor, rateBps);
          if (taxMinor === 0 || rateBps === 0) {
            expect(heads, `${treatment} ${taxMinor}@${rateBps}`).toEqual([]);
            continue;
          }
          expect(
            heads.reduce((a, h) => a + h.amount_minor, 0),
            `${treatment} ${taxMinor}@${rateBps} does not sum to the tax`,
          ).toBe(taxMinor);
          // ###############################################################
          // A ZERO HEAD IS PERMITTED HERE, AND MY FIRST ASSERTION SAID IT WAS
          // NOT. The sweep caught it, which is the point of sweeping.
          //
          // One paisa of tax on an intra-state supply is CGST 1 and SGST 0.
          // There is no other answer: two heads, and one unit to divide. And
          // the zero must be EMITTED rather than dropped, because
          // `assert_bill_line_heads_match_treatment` requires the name set on
          // the line to match the treatment's heads exactly -- a line carrying
          // only CGST would be refused at COMMIT.
          //
          // What is genuinely never permitted is a NEGATIVE head, and a set
          // that is all zeroes when tax was charged.
          // ###############################################################
          for (const h of heads) {
            expect(h.amount_minor, `${h.name} is negative`).toBeGreaterThanOrEqual(0);
          }
          expect(
            heads.some((h) => h.amount_minor > 0),
            `${treatment} ${taxMinor}@${rateBps} charged tax and every head is zero`,
          ).toBe(true);
          // The name set is the treatment's own, in ordinal order -- the
          // invariant the database asserts, asserted here too so a violation
          // fails in the splitter rather than at a COMMIT.
          expect(heads.map((h) => h.name), `${treatment} ${taxMinor}@${rateBps}`)
            .toEqual(headsOf('IN', treatment).map((h) => h.name));
          checked += 1;
        }
      }
    }
    expect(checked, 'the sweep examined nothing').toBeGreaterThan(100);
  });

  it('puts the odd unit on the FIRST head by ordinal, every time', () => {
    // Not "wherever the sort put it". 17 paise across two equal shares is 9 and
    // 8, and CGST is ordinal 1, so CGST gets the 9 -- which is the answer the
    // old halving gave, so no bill in the install moves.
    expect(splitHeads('IN', 'intra_state', 17, 500)).toEqual([
      { name: 'CGST', rate_bps: 250, amount_minor: 9 },
      { name: 'SGST', rate_bps: 250, amount_minor: 8 },
    ]);
    expect(splitHeads('IN', 'intra_state', 1, 500)[0]!.name).toBe('CGST');
  });

  it('carries no head for a treatment that collects no tax', () => {
    expect(splitHeads('IN', 'none', 1000, 500)).toEqual([]);
    // `unstated` too, and that is the point of listing it as a treatment rather
    // than omitting it: 0050 wrote it onto bills whose head cannot be
    // reconstructed, and inventing one is the failure 0037 describes.
    expect(splitHeads('IN', 'unstated', 1000, 500)).toEqual([]);
  });

  it('refuses a taxable treatment with no head, rather than reporting nothing', () => {
    // Absence is not permission. A half-filled catalogue would otherwise
    // produce a bill that charges tax and reports it under nothing at all.
    // `platform.assert_tax_shares_whole` refuses that shape at COMMIT; this is
    // the code-side refusal, which names the treatment instead of a constraint.
    const missing = new TaxHeadsMissingError('ZQ', 'domestic');
    expect(missing.code).toBe('tax_heads_missing');
    expect(missing.statusCode).toBe(422);
    expect(missing.message).toMatch(/setup gap/);
  });
});

/* ------------------------------------------------------------------ D --- */

describe('D. the database refuses what the catalogue must never hold', () => {
  it('refuses a taxable treatment with no head at all', async () => {
    // The write that touches only the TREATMENT table. Half the reason
    // `assert_tax_shares_whole` is on both tables: a taxable treatment with no
    // head is as wrong as one whose shares sum to 9500, and only one of those
    // two writes touches `tax_head`.
    await owner.query('BEGIN');
    try {
      await owner.query(
        `INSERT INTO platform.tax_jurisdiction (code, name, status, default_dial_code)
         VALUES ('ZQ','Testland','declared','999')`);
      await owner.query(
        `INSERT INTO platform.tax_treatment (jurisdiction_code, key, name, head_rule)
         VALUES ('ZQ','domestic','Domestic supply','required')`);
      await expect(owner.query('COMMIT'))
        .rejects.toThrow(/collects tax and has no head/i);
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
    }
  });

  it('refuses shares that do not sum to the whole', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query(
        `INSERT INTO platform.tax_jurisdiction (code, name, status, default_dial_code)
         VALUES ('ZR','Shareland','declared','998')`);
      await owner.query(
        `INSERT INTO platform.tax_treatment (jurisdiction_code, key, name, head_rule)
         VALUES ('ZR','domestic','Domestic supply','required')`);
      await owner.query(
        `INSERT INTO platform.tax_head
           (jurisdiction_code, treatment_key, name, share_bps, ordinal)
         VALUES ('ZR','domestic','STATE',4000,1), ('ZR','domestic','CITY',4000,2)`);
      await expect(owner.query('COMMIT')).rejects.toThrow(/8000|10000|share/i);
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
    }
  });

  it('refuses a head under a non-taxable treatment', async () => {
    await owner.query('BEGIN');
    try {
      await owner.query(
        `INSERT INTO platform.tax_jurisdiction (code, name, status, default_dial_code)
         VALUES ('ZS','Exemptland','declared','997')`);
      await owner.query(
        `INSERT INTO platform.tax_treatment (jurisdiction_code, key, name, head_rule)
         VALUES ('ZS','exempt','Exempt supply','none')`);
      await owner.query(
        `INSERT INTO platform.tax_head
           (jurisdiction_code, treatment_key, name, share_bps, ordinal)
         VALUES ('ZS','exempt','VAT',10000,1)`);
      await expect(owner.query('COMMIT')).rejects.toThrow(/may carry no head/i);
    } finally {
      await owner.query('ROLLBACK').catch(() => undefined);
    }
  });

  it('keeps the catalogue READ-ONLY to the app role', async () => {
    // ###################################################################
    // IMMUTABLE GLOBAL REFERENCE DATA, ENFORCED BY GRANTS AND NOT BY REVIEW.
    //
    // A tenant that could add a head could name its own, which is the exact
    // defect 0050 removed when it deleted `app.tax_component`: a free-text head
    // name, chosen per tenant, that a GST return then matched on. The
    // difference between "tax classes are per tenant" and "the head vocabulary
    // is not" is a GRANT, so it is asserted as one.
    // ###################################################################
    const tables = ['tax_jurisdiction', 'tax_treatment', 'tax_head'];
    const checked: string[] = [];
    for (const table of tables) {
      const priv = await owner.query<{ ins: boolean; upd: boolean; del: boolean; sel: boolean }>(
        `SELECT has_table_privilege('katkitchen_app', 'platform.' || $1, 'insert') AS ins,
                has_table_privilege('katkitchen_app', 'platform.' || $1, 'update') AS upd,
                has_table_privilege('katkitchen_app', 'platform.' || $1, 'delete') AS del,
                has_table_privilege('katkitchen_app', 'platform.' || $1, 'select') AS sel`,
        [table]);
      const row = priv.rows[0]!;
      expect({ table, ...row })
        .toEqual({ table, ins: false, upd: false, del: false, sel: true });
      checked.push(table);
    }
    assertCheckedSet({
      label: 'catalogue grants', checked, minimum: 3, mustInclude: tables,
    });

    // And through a real connection, not only through the grant catalogue.
    await expect(app.query(
      `INSERT INTO platform.tax_head
         (jurisdiction_code, treatment_key, name, share_bps, ordinal)
       VALUES ('IN','intra_state','CESS',1,9)`))
      .rejects.toThrow(/permission denied/i);
  });
});

/* ------------------------------------------------------------------ E --- */

describe('E. a tenant has a jurisdiction, and cannot not have one', () => {
  it('requires it on the tenant row, with no default to fall back on', async () => {
    const column = await owner.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema='platform' AND table_name='tenant'
          AND column_name='tax_jurisdiction'`);
    const row = column.rows[0];
    expect(row, 'platform.tenant has no tax_jurisdiction column at all').toBeDefined();
    expect(row!.is_nullable).toBe('NO');
    // NO DEFAULT is the whole point. 'IN' is the answer almost every time,
    // which is exactly why it must not fill itself in -- a forgotten field
    // would silently tax a restaurant in Dubai under Indian GST.
    expect(row!.column_default).toBeNull();
  });

  it('requires it on the bill too, because the head means nothing without it', async () => {
    const column = await owner.query<{ is_nullable: string; column_default: string | null }>(
      `SELECT is_nullable, column_default FROM information_schema.columns
        WHERE table_schema='app' AND table_name='bill'
          AND column_name='tax_jurisdiction'`);
    expect(column.rows[0]!.is_nullable).toBe('NO');
    expect(column.rows[0]!.column_default).toBeNull();
  });

  it('leaves every existing tenant and bill on a jurisdiction the code knows', async () => {
    // The backfill, asserted rather than assumed. A row carrying a code no
    // resolver answers is a restaurant that cannot bill, and it would be
    // discovered at a till.
    const known = JURISDICTIONS.map((j) => j.code);
    for (const [table, schema] of [['tenant', 'platform'], ['bill', 'app']] as const) {
      const bad = await owner.query<{ tax_jurisdiction: string; n: string }>(
        `SELECT tax_jurisdiction, count(*)::text AS n
           FROM ${schema}.${table}
          WHERE tax_jurisdiction <> ALL($1::text[])
          GROUP BY 1`, [known]);
      expect(bad.rows, `${schema}.${table} rows on an unknown jurisdiction`).toEqual([]);
    }
    // Vacuity guard: "no bad rows across no rows" must not pass.
    const total = await owner.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM platform.tenant`);
    expect(Number(total.rows[0]!.n), 'no tenants examined at all').toBeGreaterThan(0);
  });

  it('has DROPPED tax_class_rate_halves, so an odd rate is storable', async () => {
    // The constraint 0052 deleted. Asserted as ABSENT rather than trusted to
    // stay deleted: re-adding it would take 7.25% away again, and the symptom
    // would be a US tenant unable to enter their own combined rate.
    const found = await owner.query<{ conname: string }>(
      `SELECT conname FROM pg_constraint WHERE conname = 'tax_class_rate_halves'`);
    expect(found.rows, 'tax_class_rate_halves is back').toEqual([]);
  });
});
