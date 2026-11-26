import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, type Api } from '../../../services/api.js';
import { known, stale, unknown, type Remote } from '../../../lib/remote.js';
import { TableSkeleton } from '../../../components/admin/skeletons.js';
import { status } from '../../../app/admin/viz.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Card } from '@/components/ui/card.js';
import { Missing } from '../../../components/admin/missing.js';
import { TaxSplitText, useTaxSplits } from './TaxSplit.js';

/**
 * The rates a menu is priced under, and the one tax option there is.
 *
 * ###########################################################################
 * WHY THIS SCREEN IS NOT A GENERIC TABLE.
 *
 * `tax-classes` IS an ADMIN_RESOURCES entry and the generic table would render
 * it. It would render `rate_bps: 500`, which is 5% written in a unit no
 * restaurateur uses, and it would offer no way to say the thing this screen
 * exists to say.
 *
 * WHAT IT HAS TO SAY: there is nothing here that names CGST, SGST or IGST.
 *
 * Before migration 0050 there was. `app.tax_component` held one row per head
 * per class with a free-text `name`, no CHECK, and no route -- and the
 * outward-supply return bucketed a statutory figure by matching that text. A
 * restaurant whose class carried one component named 'GST 5%' got a correct
 * bill, correct money in the drawer, and a return reporting zero under every
 * head.
 *
 * The head is now derived per bill from where the supply was made. So an owner
 * states a RATE and cannot state a head, and this screen says so in the one
 * place somebody would look for the missing fields.
 * ###########################################################################
 *
 * ###########################################################################
 * THE B2B OPTION IS OFF AND STAYS OFF UNTIL SOMEBODY MEANS IT.
 *
 * `bill.recipient_gstin` has existed since migration 0039 with no write path,
 * so the whole B2B half of the GST return has always come back empty. It is
 * writable now -- and putting a GSTIN field in front of every cashier in every
 * restaurant to buy that would be paying for it with the queue.
 * ###########################################################################
 */

interface TaxClass {
  readonly id: string;
  readonly key: string;
  readonly name: string;
  readonly rate_bps: number;
  readonly status: string;
}

const pct = (bps: number): string =>
  `${(bps / 100).toFixed(bps % 100 === 0 ? 0 : 2)}%`;

export function TaxRates(props: { api: Api }): ReactElement {
  const [classes, setClasses] = useState<Remote<readonly TaxClass[]>>(
    unknown<readonly TaxClass[]>());

  const [newName, setNewName] = useState('');
  const [newRate, setNewRate] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [editRate, setEditRate] = useState('');

  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // What each rate prints as (CGST + SGST, IGST): the server's derivation, shown.
  const { splits, reread: rereadSplits } = useTaxSplits(props.api);

  const readClasses = useCallback(async (): Promise<void> => {
    try {
      const body = await props.api.get<{ rows: readonly TaxClass[] }>('/admin/tax-classes');
      setClasses(known(body.rows));
    } catch (error) {
      setClasses((current) =>
        error instanceof ApiError && error.failure.kind === 'offline'
          ? stale(current)
          : unknown<readonly TaxClass[]>(
            error instanceof ApiError && error.failure.kind === 'refused'
              && error.failure.status === 403 ? 'not-permitted' : 'read-failed'));
    }
  }, [props.api]);

  useEffect(() => { void readClasses(); }, [readClasses]);

  /**
   * Percent in, basis points out.
   *
   * Two decimal places, no rounding. 2.505% is REFUSED rather than nudged to
   * 2.51 -- accepting a rate the owner did not type is not a field to be
   * helpful about, and a tax rate is the last field to guess at.
   *
   * There is no even-number rule any more. `tax_class_rate_halves` required one
   * until 0052 deleted it; a head is a share of the rate, so an odd rate splits
   * as cleanly as an even one.
   */
  const bpsFrom = (given: string): number | null => {
    const trimmed = given.trim().replace(/%$/, '');
    if (!/^\d+(\.\d{1,2})?$/.test(trimmed)) return null;
    const bps = Math.round(Number(trimmed) * 100);
    return bps;
  };

  const create = async (): Promise<void> => {
    setRefusal(null); setDone(null);
    const bps = bpsFrom(newRate);
    if (bps === null) {
      setRefusal('Enter the rate as a percentage — 5, 12, 18, or 2.5.');
      return;
    }
    if (newName.trim().length === 0) {
      setRefusal('Give the rate a name an owner would recognise, like “GST 5% (restaurant)”.');
      return;
    }
    setBusy(true);
    try {
      await props.api.postDetailed('/admin/tax-classes', {
        // Derived from the name rather than asked for. `tax_class_key_format`
        // wants a slug and a second field is a second thing to get wrong; the
        // key is an internal handle, not something an owner reads.
        key: `r${bps}_${Date.now().toString(36)}`,
        name: newName.trim(),
        rate_bps: bps,
      });
      setDone(`Added ${newName.trim()} at ${pct(bps)}.`);
      setNewName(''); setNewRate('');
      await readClasses();
      await rereadSplits();
    } catch (error) {
      // The server's own sentence, verbatim -- a constraint refusal arrives here
      // as a sentence via CONSTRAINT_DETAIL, and paraphrasing it in the client
      // is how the two come to say different things.
      setRefusal(error instanceof Error ? error.message : 'That did not go through.');
    } finally { setBusy(false); }
  };

  const saveRate = async (cls: TaxClass): Promise<void> => {
    setRefusal(null); setDone(null);
    const bps = bpsFrom(editRate);
    if (bps === null) { setRefusal('Enter the rate as a percentage.'); return; }
    setBusy(true);
    try {
      await props.api.patchDetailed(`/admin/tax-classes/${cls.id}`, { rate_bps: bps });
      setDone(`${cls.name} is now ${pct(bps)}. Orders already taken keep the old rate.`);
      setEditing(null);
      await readClasses();
      await rereadSplits();
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : 'That did not go through.');
    } finally { setBusy(false); }
  };

  const archive = async (cls: TaxClass): Promise<void> => {
    setRefusal(null); setDone(null);
    setBusy(true);
    try {
      await props.api.remove(`/admin/tax-classes/${cls.id}`);
      setDone(`${cls.name} is retired. Dishes already priced under it keep their rate.`);
      await readClasses();
      await rereadSplits();
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : 'That did not go through.');
    } finally { setBusy(false); }
  };

  return (
    <div className="max-w-[820px]">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Tax rates</h1>
      <p className="mb-5 text-[13px] leading-relaxed text-foreground/70 text-pretty">
        Every dish is priced under one of these. A rate applies to orders taken
        from now on — an order already on a table keeps the rate it was taken at,
        and so does every bill already printed.
      </p>

      {/* This refusal/done pair is deliberately NOT the shared RefusalBanner /
          DoneBanner used elsewhere on this client: the ORIGINAL implementation
          coloured its refusal with viz.ts's `status.critical` (#d03b3b) rather
          than the --color-destructive reservation (a.stop, #C1121F) every other
          screen's refusal box uses. That is a genuine pre-existing
          inconsistency in the source, not a documented decision, and this phase
          preserves the exact colour rather than silently normalising it. */}
      {refusal !== null && (
        <div className="mb-5 rounded-[4px] border p-5 text-[13px] leading-relaxed"
          style={{ borderColor: status.critical, background: '#FDECEC', color: status.critical }}>
          {refusal}
        </div>
      )}
      {done !== null && (
        <div className="mb-5 rounded-[4px] border p-5 text-[13px]"
          style={{ borderColor: '#1c6b1c', background: '#EAF6EA', color: '#1c6b1c' }}>
          {done}
        </div>
      )}

      <Card className="mb-5 gap-0 rounded-[4px] border-border p-5">
        {classes.state === 'unknown' && classes.reason === 'never-read' ? (
          <TableSkeleton label="tax rates" columns={2} rows={3} className="border-0" />
        ) : classes.state === 'unknown' ? (
          <Missing reason={classes.reason}>
            {classes.reason === 'not-permitted'
              ? 'You do not have permission to see the tax rates.'
              : 'The tax rates could not be read just now.'}
          </Missing>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="text-left text-xs text-muted-foreground">
                  <th className="pb-2">Name</th>
                  <th className="w-[90px] pb-2">Rate</th>
                  <th className="pb-2">On a bill</th>
                  <th className="w-[200px] pb-2" />
                </tr>
              </thead>
              <tbody>
                {classes.value.length === 0 && (
                  <tr><td colSpan={4} className="py-3 text-foreground/70">
                    {/* This is what a pre-0050 tenant saw, and it is why a dish
                        could not be added. Kept as a real state rather than an
                        empty table, because it is actionable. */}
                    No rates yet. Add one below — until there is one, no dish can be
                    priced.
                  </td></tr>
                )}
                {classes.value.map((cls) => (
                  <tr key={cls.id} className="border-t border-border">
                    <td className="py-2.5">{cls.name}</td>
                    <td className="py-2.5 font-mono">
                      {editing === cls.id ? (
                        <Input
                          value={editRate}
                          onChange={(e) => setEditRate(e.target.value)}
                          className="h-[30px] w-[70px]"
                          aria-label={`Rate for ${cls.name}`}
                        />
                      ) : pct(cls.rate_bps)}
                    </td>
                    <td className="py-2.5 text-xs leading-snug">
                      <TaxSplitText splits={splits} taxClassId={cls.id} />
                    </td>
                    <td className="py-2.5 text-right">
                      {editing === cls.id ? (
                        <>
                          <Button type="button" variant="outline" size="sm" disabled={busy}
                            onClick={() => void saveRate(cls)}
                            className="mr-2 h-[30px] border-[1.5px] border-foreground text-sm font-semibold">
                            Save
                          </Button>
                          <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(null)}
                            className="h-[30px] font-normal text-foreground/70">
                            Cancel
                          </Button>
                        </>
                      ) : (
                        <>
                          <Button type="button" variant="outline" size="sm"
                            onClick={() => {
                              setEditing(cls.id);
                              setEditRate((cls.rate_bps / 100).toString());
                            }}
                            className="mr-2 h-[30px] border-[1.5px] border-foreground text-sm font-semibold">
                            Change rate
                          </Button>
                          <Button type="button" variant="ghost" size="sm" disabled={busy}
                            onClick={() => void archive(cls)}
                            className="h-[30px] font-normal text-foreground/70">
                            Retire
                          </Button>
                        </>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div className="mt-[18px] flex flex-wrap items-center gap-2">
          <Input value={newName} onChange={(e) => setNewName(e.target.value)}
            placeholder="GST 5% (restaurant)"
            className="h-9 grow" aria-label="New rate name" />
          <Input value={newRate} onChange={(e) => setNewRate(e.target.value)}
            placeholder="5"
            className="h-9 w-20" aria-label="New rate percentage" />
          <Button type="button" disabled={busy} onClick={() => void create()}
            className="h-9 border-transparent bg-brand-gradient text-sm font-semibold text-white hover:opacity-90">
            Add rate
          </Button>
        </div>
      </Card>

      {/* ###################################################################
          THE ABSENT FIELDS, NAMED.

          Somebody who has configured a POS before will look for CGST and SGST
          here and conclude the product cannot do GST. So the screen says where
          they went -- and the reason is not an implementation note, it is the
          thing that decides whether their return is filable.
          ################################################################### */}
      <Card className="mb-5 gap-0 rounded-[4px] border-border bg-background p-5">
        <h2 className="mb-2 text-[15px] font-bold">Why CGST and SGST are shown, not typed</h2>
        <p className="m-0 text-[13px] leading-relaxed text-foreground/70 text-pretty">
          Whether a rate arrives on a bill as CGST + SGST or as IGST depends on
          where the supply was made, not on how the rate was set up. Each bill
          works it out from the branch’s state and records what it decided, so
          the heads always add back to the tax on the bill and a GST return can
          be built from the bills themselves. The “On a bill” column shows that
          split for each rate — CGST and SGST are always half the rate each, IGST
          is the whole rate — so there is nothing to configure, and nothing to
          spell wrong.
        </p>
      </Card>

    </div>
  );
}
