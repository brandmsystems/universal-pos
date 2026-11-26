import { useState } from 'react';
import type { ReactElement } from 'react';
import { Plus } from 'lucide-react';
import type { Api } from '../../../../services/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Badge } from '@/components/ui/badge.js';
import { FormModal } from '../../../../components/admin/form-modal.js';
import { RefusalBanner } from '../../../../components/admin/banner.js';
import {
  Field, ModalFooter, StepHeader, StepTable, currencySymbol, formatRupees, paiseFrom, refusalOf, rupeesFrom, selectClass,
  useList, withBranch,
} from './common.js';
import type { KitchenRow } from './KitchensStep.js';
import { AddOnsSection, type AddOnGroup } from './AddOnsSection.js';
import { TaxSplitText, useTaxSplits } from '../TaxSplit.js';
import { useBusiness } from '../../../../lib/businessContext.js';

interface ItemRow {
  readonly id: string;
  readonly name: string;
  readonly kind: 'single' | 'combo' | 'product';
  readonly price_minor: number;
  readonly category_id: string | null;
  readonly station_code: string | null;
  readonly tax_class_id: string | null;
  readonly prep_minutes: number | null;
  readonly barcode: string | null;
}
interface CategoryRow { readonly id: string; readonly name: string }
interface TaxRow { readonly id: string; readonly key: string; readonly name: string }
interface Detail {
  readonly id: string; readonly name: string; readonly description: string | null; readonly barcode: string | null;
  readonly categoryId: string | null; readonly kind: 'single' | 'combo' | 'product'; readonly kitchenCode: string | null;
  readonly priceMinor: number; readonly prepMinutes: number | null; readonly taxClassId: string;
  readonly addOnGroupIds: readonly string[]; readonly components: readonly { itemId: string; quantity: number }[];
}

interface Draft {
  name: string; description: string; barcode: string; categoryId: string; kind: 'single' | 'combo' | 'product' | '';
  kitchenCode: string; price: string; prepMinutes: string; taxClassId: string;
  addOns: string[]; components: { itemId: string; quantity: string }[];
}

const EMPTY: Draft = {
  name: '', description: '', barcode: '', categoryId: '', kind: 'single', kitchenCode: '', price: '',
  prepMinutes: '', taxClassId: '', addOns: [], components: [],
};

/** What the Type column and badge say for a row. */
const kindWord = (kind: string): string => (kind === 'combo' ? 'Combo' : kind === 'product' ? 'Product' : 'Single');

export function ItemsStep(props: { api: Api; branchId: string | null; onChanged?: () => void }): ReactElement {
  // A shop sells products (no kitchen); a restaurant sells single dishes and combos.
  const business = useBusiness();
  const counter = business.workflow === 'counter_sale';
  const items = useList<ItemRow>(props.api, '/admin/menu/items');
  const categories = useList<CategoryRow>(props.api, '/admin/menu/categories');
  const kitchens = useList<KitchenRow>(props.api, withBranch('/admin/kitchens', props.branchId));
  const taxes = useList<TaxRow>(props.api, '/admin/tax-classes');
  // CGST / SGST / IGST for the chosen rate: shown, never typed (one GST rate per item).
  const { splits } = useTaxSplits(props.api);
  const addOns = useList<AddOnGroup>(props.api, '/admin/addons');
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY);
  // The description is optional and folded away behind + until wanted; one already written stays open.
  const [describing, setDescribing] = useState(false);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]): void => setDraft((d) => ({ ...d, [key]: value }));
  const categoryName = (id: string | null): string => categories.rows?.find((c) => c.id === id)?.name ?? '—';
  const kitchenName = (code: string | null): string => kitchens.rows?.find((k) => k.code === code)?.name ?? code ?? '—';

  async function open(row: ItemRow | 'new'): Promise<void> {
    setDescribing(false);
    setTouched(false); setRefusal(null);
    if (row === 'new') {
      const gst5 = taxes.rows?.find((t) => t.key === 'gst_5');
      setDraft({ ...EMPTY, kind: counter ? 'product' : 'single', taxClassId: gst5?.id ?? '' });
      setEditing('new');
      return;
    }
    try {
      const d = await props.api.get<Detail>(`/admin/menu/items/${row.id}`);
      setDraft({
        name: d.name, description: d.description ?? '', barcode: d.barcode ?? '', categoryId: d.categoryId ?? '',
        kind: d.kind, kitchenCode: d.kitchenCode ?? '', price: rupeesFrom(d.priceMinor),
        prepMinutes: d.prepMinutes === null ? '' : String(d.prepMinutes), taxClassId: d.taxClassId,
        addOns: [...d.addOnGroupIds], components: d.components.map((c) => ({ itemId: c.itemId, quantity: String(c.quantity) })),
      });
      setEditing(row.id);
    } catch (error) {
      setNotice(refusalOf(error));
    }
  }

  const priceMinor = paiseFrom(draft.price);
  const errors = {
    name: draft.name.trim() === '' ? 'Name is required.' : null,
    kind: draft.kind === '' ? (counter ? 'Choose the type.' : 'Choose Single or Combo.') : null,
    kitchen: draft.kind === 'single' && draft.kitchenCode === '' ? 'Choose the kitchen that makes it.' : null,
    price: priceMinor === null ? 'A price like 249 or 249.50.' : null,
    tax: draft.taxClassId === '' ? 'Choose the tax rate.' : null,
    prep: draft.prepMinutes !== '' && !(Number(draft.prepMinutes) >= 1 && Number(draft.prepMinutes) <= 240) ? '1 to 240 minutes.' : null,
    barcode: draft.barcode.trim() !== '' && !/^[A-Za-z0-9-]{4,64}$/.test(draft.barcode.trim()) ? '4 to 64 letters, digits or dashes.' : null,
    components: draft.kind === 'combo' && (draft.components.length === 0 || draft.components.some((c) => c.itemId === ''))
      ? 'Pick the dishes in the combo.' : null,
  };
  const valid = Object.values(errors).every((e) => e === null);
  const show = (e: string | null): string | null => (touched ? e : null);

  async function save(): Promise<void> {
    setTouched(true);
    if (!valid || editing === null) return;
    setBusy(true); setRefusal(null);
    const body = {
      name: draft.name.trim(),
      description: draft.description.trim() === '' ? null : draft.description.trim(),
      barcode: draft.barcode.trim() === '' ? null : draft.barcode.trim(),
      categoryId: draft.categoryId === '' ? null : draft.categoryId,
      priceMinor,
      prepMinutes: draft.prepMinutes === '' ? null : Number(draft.prepMinutes),
      taxClassId: draft.taxClassId,
      addOnGroupIds: draft.addOns,
      ...(draft.kind === 'single' ? { kitchenCode: draft.kitchenCode } : {}),
      ...(draft.kind === 'combo' ? { components: draft.components.map((c) => ({ itemId: c.itemId, quantity: Number(c.quantity || '1') })) } : {}),
    };
    try {
      if (editing === 'new') {
        const made = await props.api.postDetailed<{ listed: boolean; notListedBecause: string | null }>(
          withBranch('/admin/menu/items', props.branchId), { ...body, kind: draft.kind });
        setNotice(made.listed ? `${draft.name.trim()} is on sale.`
          : `${draft.name.trim()} was saved but is not on sale yet: ${made.notListedBecause ?? 'it could not be listed.'}`);
      } else {
        await props.api.patchDetailed(`/admin/menu/items/${editing}`, body);
        setNotice(`${draft.name.trim()} was updated.`);
      }
      setEditing(null);
      await items.reload();
      props.onChanged?.();
    } catch (error) {
      setRefusal(refusalOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: ItemRow): Promise<void> {
    if (!window.confirm(`Take ${row.name} off the menu?`)) return;
    try { await props.api.remove(`/admin/menu/items/${row.id}`); await items.reload(); props.onChanged?.(); }
    catch (error) { window.alert(refusalOf(error)); }
  }

  const singles = (items.rows ?? []).filter((i) => i.kind === 'single' && i.id !== editing);
  const noKitchens = kitchens.rows !== null && kitchens.rows.length === 0;

  return (
    <div className="flex flex-col gap-8">
      <section className="flex flex-col gap-3">
        <StepHeader title="Food items" addLabel="Add food item" onAdd={() => { void open('new'); }}
          hint="Every dish and drink: its price, the kitchen that makes it and the add-ons a guest can choose."
          disabled={noKitchens ? 'Add a kitchen first — every dish is made in one.' : undefined} />
        {notice !== null && <div className="rounded-md border border-border bg-accent px-3 py-2 text-sm">{notice}</div>}
        <StepTable rows={items.rows} failed={items.failed} noun="food items" empty="No food items yet." onEdit={(row) => { void open(row); }}
          onRemove={(row) => { void remove(row); }}
          columns={[
            { title: 'Item', value: (row) => `${row.name} ${row.barcode ?? ''}`, render: (row) => <span className="font-semibold">{row.name}</span> },
            { title: 'Type', value: (row) => kindWord(row.kind), render: (row) => <Badge variant="secondary">{kindWord(row.kind)}</Badge> },
            { title: 'Category', value: (row) => categoryName(row.category_id), render: (row) => categoryName(row.category_id) },
            { title: 'Kitchen', value: (row) => (row.kind === 'combo' ? 'from its dishes' : row.kind === 'product' ? 'none' : kitchenName(row.station_code)), render: (row) => (row.kind === 'combo' ? 'from its dishes' : row.kind === 'product' ? 'none' : kitchenName(row.station_code)) },
            { title: 'Price', value: (row) => Number(row.price_minor), render: (row) => <span className="font-mono">{formatRupees(Number(row.price_minor))}</span> },
            { title: 'Time', value: (row) => row.prep_minutes, render: (row) => (row.prep_minutes === null ? '—' : `${row.prep_minutes} min`) },
          ]}
          filters={[
            { kind: 'choice', label: 'Category', value: (row) => categoryName(row.category_id) },
            { kind: 'choice', label: 'Kitchen', value: (row) => (row.kind === 'combo' || row.kind === 'product' ? null : kitchenName(row.station_code)) },
            { kind: 'choice', label: 'Tax', value: (row) => taxes.rows?.find((t) => t.id === row.tax_class_id)?.name ?? null },
            { kind: 'choice', label: 'Type', value: (row) => kindWord(row.kind) },
            { kind: 'range', label: `Price ${currencySymbol()}`, value: (row) => Number(row.price_minor), scale: 100 },
          ]} />
      </section>

      <AddOnsSection api={props.api} groups={addOns.rows} failed={addOns.failed} reload={addOns.reload} />

      <FormModal open={editing !== null} busy={busy} wide onClose={() => setEditing(null)}
        title={editing === 'new' ? `Add ${counter ? business.terms.item.toLowerCase() : 'food item'}` : `Edit ${counter ? business.terms.item.toLowerCase() : 'food item'}`}
        footer={<ModalFooter busy={busy} saveLabel={editing === 'new' ? 'Add item' : 'Save changes'}
          onSave={() => { void save(); }} onCancel={() => setEditing(null)} />}>
        <div className="flex flex-col gap-3.5">
          {refusal !== null && <RefusalBanner>{refusal}</RefusalBanner>}
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field label="Name" required error={show(errors.name)}>
              <Input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Butter Naan" className="h-10" />
            </Field>
            <Field label="Type" required error={show(errors.kind)} hint={editing !== 'new' ? 'Cannot be changed after it is created.' : undefined}>
              <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label={counter ? 'Type' : 'Single or combo'}>
                {(counter ? (['product'] as const) : (['single', 'combo'] as const)).map((value) => (
                  <button key={value} type="button" role="radio" aria-checked={draft.kind === value}
                    disabled={editing !== 'new'} onClick={() => set('kind', value)}
                    className={`h-10 rounded-md border text-sm font-semibold disabled:opacity-60 ${draft.kind === value ? 'border-primary bg-accent' : 'border-border'}`}>
                    {kindWord(value)}
                  </button>
                ))}
              </div>
            </Field>
          </div>
          {draft.description === '' && !describing ? (
            <button type="button" onClick={() => setDescribing(true)}
              className="flex h-9 w-fit items-center gap-1.5 rounded-md px-2 text-sm font-semibold text-muted-foreground transition-colors hover:bg-accent hover:text-foreground">
              <Plus aria-hidden className="size-4" /> Add description
            </button>
          ) : (
            <Field label="Description">
              <Input value={draft.description} onChange={(e) => set('description', e.target.value)} maxLength={1000}
                autoFocus={draft.description === ''} placeholder="Soft leavened bread, finished with butter" className="h-10" />
            </Field>
          )}
          <div className="grid gap-3.5 sm:grid-cols-3">
            <Field label={`Price (${currencySymbol()})`} required error={show(errors.price)}>
              <Input value={draft.price} inputMode="decimal" onChange={(e) => set('price', e.target.value)} placeholder="249.00" className="h-10 font-mono" />
            </Field>
            <Field label="Tax" required error={show(errors.tax)}>
              <select value={draft.taxClassId} onChange={(e) => set('taxClassId', e.target.value)} className={selectClass}>
                <option value="">Choose tax</option>
                {(taxes.rows ?? []).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
              {draft.taxClassId !== '' && (
                <TaxSplitText splits={splits} taxClassId={draft.taxClassId}
                  className="mt-1 block text-[11px] leading-snug text-foreground/70" />
              )}
            </Field>
            {draft.kind !== 'product' && <Field label="Preparation time (min)" error={show(errors.prep)}>
              <Input value={draft.prepMinutes} inputMode="numeric" onChange={(e) => set('prepMinutes', e.target.value.replace(/\D/g, ''))} placeholder="15" className="h-10" />
            </Field>}
          </div>
          <div className="grid gap-3.5 sm:grid-cols-3">
            <Field label="Category">
              <select value={draft.categoryId} onChange={(e) => set('categoryId', e.target.value)} className={selectClass}>
                <option value="">No category</option>
                {(categories.rows ?? []).map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </Field>
            {draft.kind === 'single' && (
              <Field label="Kitchen" required error={show(errors.kitchen)}>
                <select value={draft.kitchenCode} onChange={(e) => set('kitchenCode', e.target.value)} className={selectClass}>
                  <option value="">Choose kitchen</option>
                  {(kitchens.rows ?? []).map((k) => (
                    <option key={k.id} value={k.code}>{k.name} ({k.kind === 'food' ? 'Food' : 'Beverage'})</option>
                  ))}
                </select>
              </Field>
            )}
            <Field label="Barcode" error={show(errors.barcode)}>
              <Input value={draft.barcode} onChange={(e) => set('barcode', e.target.value)} placeholder="8901234567890" className="h-10 font-mono" />
            </Field>
          </div>

          {draft.kind === 'combo' && (
            <Field label="Dishes in the combo" required error={show(errors.components)}>
              <div className="flex flex-col gap-2">
                {draft.components.map((c, i) => (
                  <div key={i} className="flex items-center gap-2">
                    <select value={c.itemId} className={selectClass}
                      onChange={(e) => set('components', draft.components.map((x, j) => (j === i ? { ...x, itemId: e.target.value } : x)))}>
                      <option value="">Choose a dish</option>
                      {singles.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                    </select>
                    <Input value={c.quantity} inputMode="numeric" className="h-10 w-20" aria-label="Quantity"
                      onChange={(e) => set('components', draft.components.map((x, j) => (j === i ? { ...x, quantity: e.target.value.replace(/\D/g, '') } : x)))} />
                    <Button type="button" variant="ghost" size="sm"
                      onClick={() => set('components', draft.components.filter((_, j) => j !== i))}>Remove</Button>
                  </div>
                ))}
                <Button type="button" variant="outline" size="sm" className="w-fit"
                  onClick={() => set('components', [...draft.components, { itemId: '', quantity: '1' }])}>Add dish</Button>
              </div>
            </Field>
          )}

          <Field label="Add-ons" hint={(addOns.rows ?? []).length === 0 ? 'No add-on groups yet — add them below the item list.' : 'Extras a guest can choose with this item.'}>
            <div className="flex flex-wrap gap-2">
              {(addOns.rows ?? []).map((g) => {
                const on = draft.addOns.includes(g.id);
                return (
                  <button key={g.id} type="button" aria-pressed={on}
                    onClick={() => set('addOns', on ? draft.addOns.filter((x) => x !== g.id) : [...draft.addOns, g.id])}
                    className={`rounded-full border px-3 py-1 text-sm ${on ? 'border-primary bg-accent font-semibold' : 'border-border'}`}>
                    {g.name}
                  </button>
                );
              })}
            </div>
          </Field>
        </div>
      </FormModal>
    </div>
  );
}
