import { useState } from 'react';
import type { ReactElement } from 'react';
import type { Api } from '../../../../services/api.js';
import { Input } from '@/components/ui/input.js';
import { Badge } from '@/components/ui/badge.js';
import { FormModal } from '../../../../components/admin/form-modal.js';
import { RefusalBanner } from '../../../../components/admin/banner.js';
import {
  Field, ModalFooter, StepHeader, StepTable, refusalOf, selectClass, useList, withBranch,
} from './common.js';

export interface KitchenRow {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly kind: 'food' | 'beverage';
  readonly displayOrder: number;
  readonly printerId: string | null;
  readonly printerName: string | null;
}

interface PrinterRow { readonly id: string; readonly name: string }

export function KitchensStep(props: { api: Api; branchId: string | null; onChanged?: () => void }): ReactElement {
  const kitchens = useList<KitchenRow>(props.api, withBranch('/admin/kitchens', props.branchId));
  const printers = useList<PrinterRow>(props.api, withBranch('/admin/printers', props.branchId));
  const [editing, setEditing] = useState<KitchenRow | 'new' | null>(null);
  const [name, setName] = useState('');
  const [kind, setKind] = useState<'food' | 'beverage' | ''>('');
  const [printerId, setPrinterId] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  function open(row: KitchenRow | 'new'): void {
    setEditing(row); setTouched(false); setRefusal(null);
    setName(row === 'new' ? '' : row.name);
    setKind(row === 'new' ? '' : row.kind);
    setPrinterId(row === 'new' ? (printers.rows?.length === 1 ? printers.rows[0]!.id : '') : row.printerId ?? '');
  }

  const errors = {
    name: name.trim() === '' ? 'Name is required.' : null,
    kind: kind === '' ? 'Choose Food or Beverage.' : null,
    printer: printerId === '' ? 'Choose the printer its tickets print on.' : null,
  };
  const valid = Object.values(errors).every((e) => e === null);

  async function save(): Promise<void> {
    setTouched(true);
    if (!valid || editing === null) return;
    setBusy(true); setRefusal(null);
    try {
      const body = { name: name.trim(), kind, printerId };
      if (editing === 'new') await props.api.postDetailed(withBranch('/admin/kitchens', props.branchId), body);
      else await props.api.patchDetailed(`/admin/kitchens/${editing.id}`, body);
      setEditing(null);
      await kitchens.reload();
      props.onChanged?.();
    } catch (error) {
      setRefusal(refusalOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: KitchenRow): Promise<void> {
    if (!window.confirm(`Remove the ${row.name} kitchen?`)) return;
    try {
      await props.api.remove(`/admin/kitchens/${row.id}`);
      await kitchens.reload();
      props.onChanged?.();
    } catch (error) {
      window.alert(refusalOf(error));
    }
  }

  const noPrinters = printers.rows !== null && printers.rows.length === 0;
  const show = (e: string | null): string | null => (touched ? e : null);

  return (
    <section className="flex flex-col gap-3">
      <StepHeader title="Kitchens" addLabel="Add kitchen"
        hint="Where dishes are made. Each item is sent to one kitchen, and its tickets print on that kitchen's printer."
        disabled={noPrinters ? 'Add a printer first — every kitchen prints its tickets on one.' : undefined}
        onAdd={() => open('new')} />
      <StepTable rows={kitchens.rows} failed={kitchens.failed} noun="kitchens" empty="No kitchens yet. Add Kitchen1, Juice, Chat Kitchen, Coffee Tea…"
        onEdit={open} onRemove={(row) => { void remove(row); }}
        columns={[
          { title: 'Kitchen', value: (row) => row.name, render: (row) => <span className="font-semibold">{row.name}</span> },
          { title: 'Type', value: (row) => (row.kind === 'food' ? 'Food' : 'Beverage'), render: (row) => <Badge variant="secondary">{row.kind === 'food' ? 'Food' : 'Beverage'}</Badge> },
          { title: 'Printer', value: (row) => row.printerName, render: (row) => row.printerName ?? <span className="text-destructive">none</span> },
        ]}
        filters={[
          { kind: 'choice', label: 'Type', value: (row) => (row.kind === 'food' ? 'Food' : 'Beverage') },
          { kind: 'choice', label: 'Printer', value: (row) => row.printerName },
        ]} />
      <FormModal open={editing !== null} busy={busy} onClose={() => setEditing(null)}
        title={editing === 'new' ? 'Add kitchen' : 'Edit kitchen'}
        footer={<ModalFooter busy={busy} saveLabel={editing === 'new' ? 'Add kitchen' : 'Save changes'}
          onSave={() => { void save(); }} onCancel={() => setEditing(null)} />}>
        <div className="flex flex-col gap-3.5">
          {refusal !== null && <RefusalBanner>{refusal}</RefusalBanner>}
          <Field label="Kitchen name" required error={show(errors.name)}>
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Juice" className="h-10" />
          </Field>
          <Field label="Type" required error={show(errors.kind)}>
            <div className="grid grid-cols-2 gap-2" role="radiogroup" aria-label="Kitchen type">
              {(['food', 'beverage'] as const).map((value) => (
                <button key={value} type="button" role="radio" aria-checked={kind === value} onClick={() => setKind(value)}
                  className={`h-10 rounded-md border text-sm font-semibold ${kind === value ? 'border-primary bg-accent' : 'border-border'}`}>
                  {value === 'food' ? 'Food' : 'Beverage'}
                </button>
              ))}
            </div>
          </Field>
          <Field label="Printer" required error={show(errors.printer)}>
            <select value={printerId} onChange={(e) => setPrinterId(e.target.value)} className={selectClass}>
              <option value="">Choose a printer</option>
              {(printers.rows ?? []).map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </select>
          </Field>
        </div>
      </FormModal>
    </section>
  );
}
