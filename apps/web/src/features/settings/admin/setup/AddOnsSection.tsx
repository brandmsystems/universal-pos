import { useState } from 'react';
import type { ReactElement } from 'react';
import type { Api } from '../../../../services/api.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { FormModal } from '../../../../components/admin/form-modal.js';
import { RefusalBanner } from '../../../../components/admin/banner.js';
import { RequiredMark } from '../../../../components/admin/required-mark.js';
import {
  Field, ModalFooter, StepHeader, StepTable, currencySymbol, formatRupees, paiseFrom, refusalOf, rupeesFrom,
} from './common.js';

export interface AddOnGroup {
  readonly id: string;
  readonly name: string;
  readonly minSelect: number;
  readonly maxSelect: number | null;
  readonly options: readonly { id: string; name: string; priceDeltaMinor: number }[];
}

interface OptionDraft { id?: string; name: string; price: string }

export function AddOnsSection(props: {
  api: Api;
  groups: readonly AddOnGroup[] | null;
  failed: boolean;
  reload: () => Promise<void>;
}): ReactElement {
  const [editing, setEditing] = useState<AddOnGroup | 'new' | null>(null);
  const [name, setName] = useState('');
  const [maxSelect, setMaxSelect] = useState('');
  const [options, setOptions] = useState<OptionDraft[]>([]);
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  function open(row: AddOnGroup | 'new'): void {
    setEditing(row); setTouched(false); setRefusal(null);
    setName(row === 'new' ? '' : row.name);
    setMaxSelect(row === 'new' || row.maxSelect === null ? '' : String(row.maxSelect));
    setOptions(row === 'new' ? [{ name: '', price: '' }]
      : row.options.map((o) => ({ id: o.id, name: o.name, price: rupeesFrom(o.priceDeltaMinor) })));
  }

  const badOption = options.findIndex((o) => o.name.trim() === '' || (o.price.trim() !== '' && paiseFrom(o.price.replace(/^-/, '')) === null));
  const errors = {
    name: name.trim() === '' ? 'Name is required.' : null,
    options: options.length === 0 ? 'Add at least one option.' : badOption >= 0 ? `Option ${badOption + 1} needs a name and a valid price.` : null,
  };

  async function save(): Promise<void> {
    setTouched(true);
    if (errors.name !== null || errors.options !== null || editing === null) return;
    setBusy(true); setRefusal(null);
    try {
      const body = {
        name: name.trim(),
        minSelect: 0,
        maxSelect: maxSelect === '' ? null : Number(maxSelect),
        options: options.map((o) => {
          const negative = o.price.trim().startsWith('-');
          const paise = o.price.trim() === '' ? 0 : paiseFrom(o.price.trim().replace(/^-/, ''))!;
          return { ...(o.id ? { id: o.id } : {}), name: o.name.trim(), priceDeltaMinor: negative ? -paise : paise };
        }),
      };
      if (editing === 'new') await props.api.postDetailed('/admin/addons', body);
      else await props.api.patchDetailed(`/admin/addons/${editing.id}`, body);
      setEditing(null);
      await props.reload();
    } catch (error) {
      setRefusal(refusalOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: AddOnGroup): Promise<void> {
    if (!window.confirm(`Remove the ${row.name} add-ons from every item?`)) return;
    try { await props.api.remove(`/admin/addons/${row.id}`); await props.reload(); }
    catch (error) { window.alert(refusalOf(error)); }
  }

  return (
    <section className="flex flex-col gap-3">
      <StepHeader title="Add-ons" addLabel="Add add-on group" onAdd={() => open('new')}
        hint={`Extras a guest can choose, like Extra cheese +${currencySymbol()}30. Attach them to food items.`} />
      <StepTable rows={props.groups} failed={props.failed} noun="add-on groups" empty="No add-ons yet." onEdit={open}
        onRemove={(row) => { void remove(row); }}
        columns={[
          { title: 'Group', value: (row) => row.name, render: (row) => <span className="font-semibold">{row.name}</span> },
          { title: 'Options', value: (row) => row.options.map((o) => o.name).join(' '), render: (row) => row.options.map((o) => `${o.name} ${o.priceDeltaMinor === 0 ? '' : `+${formatRupees(o.priceDeltaMinor)}`}`.trim()).join(', ') },
          { title: 'Up to', render: (row) => (row.maxSelect === null ? 'any' : row.maxSelect) },
        ]} />
      <FormModal open={editing !== null} busy={busy} onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Add add-on group' : 'Edit add-on group'}
        footer={<ModalFooter busy={busy} saveLabel={editing === 'new' ? 'Add group' : 'Save changes'}
          onSave={() => { void save(); }} onCancel={() => setEditing(null)} />}>
        <div className="flex flex-col gap-3.5">
          {refusal !== null && <RefusalBanner>{refusal}</RefusalBanner>}
          <div className="grid gap-3.5 sm:grid-cols-2">
            <Field label="Group name" required error={touched ? errors.name : null}>
              <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Extras" className="h-10" />
            </Field>
            <Field label="Guest may choose up to" hint="Blank: as many as they like.">
              <Input value={maxSelect} inputMode="numeric" onChange={(e) => setMaxSelect(e.target.value.replace(/\D/g, ''))} className="h-10" />
            </Field>
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Options<RequiredMark /></span>
            {options.map((option, i) => (
              <div key={option.id ?? `new-${i}`} className="flex items-center gap-2">
                <Input value={option.name} placeholder="Extra cheese" className="h-10"
                  onChange={(e) => setOptions((all) => all.map((o, j) => (j === i ? { ...o, name: e.target.value } : o)))} />
                <Input value={option.price} placeholder="30.00" inputMode="decimal" className="h-10 w-32 font-mono"
                  onChange={(e) => setOptions((all) => all.map((o, j) => (j === i ? { ...o, price: e.target.value } : o)))} />
                <Button type="button" variant="ghost" size="sm" onClick={() => setOptions((all) => all.filter((_, j) => j !== i))}>Remove</Button>
              </div>
            ))}
            {touched && errors.options !== null && <span className="text-[11px] text-destructive">{errors.options}</span>}
            <Button type="button" variant="outline" size="sm" className="w-fit"
              onClick={() => setOptions((all) => [...all, { name: '', price: '' }])}>Add option</Button>
            <span className="text-[11px] text-muted-foreground">Price in {currencySymbol()}, added to the dish. Use a minus for a discount, e.g. -10 for "no cheese".</span>
          </div>
        </div>
      </FormModal>
    </section>
  );
}
