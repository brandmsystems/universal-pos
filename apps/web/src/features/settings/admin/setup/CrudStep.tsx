import { useState } from 'react';
import type { ReactElement } from 'react';
import type { Api } from '../../../../services/api.js';
import { Input } from '@/components/ui/input.js';
import { FormModal } from '../../../../components/admin/form-modal.js';
import { RefusalBanner } from '../../../../components/admin/banner.js';
import {
  Field, ModalFooter, StepHeader, StepTable, refusalOf, selectClass, useList, withBranch, type Column, type Filter,
} from './common.js';

/**
 * One setup step backed by a declared admin resource: a list, and an Add/Edit
 * popup built from a field list. Required fields are marked and checked before
 * sending; the server checks them again and its refusal is shown in the popup.
 */

export interface StepField {
  readonly name: string;
  readonly label: string;
  readonly required?: boolean;
  readonly type?: 'text' | 'number' | 'select';
  readonly options?: readonly { value: string; label: string }[];
  readonly placeholder?: string;
  readonly hint?: string;
  /** Shown but not changeable once created (the server has no edit for it). */
  readonly createOnly?: boolean;
  /** Shown, required and sent only while this holds. */
  readonly showIf?: (values: Readonly<Record<string, string>>) => boolean;
  /** A live check, so the form refuses what the server would. */
  readonly problem?: (value: string, values: Readonly<Record<string, string>>) => string | null;
  /** A form-only field: never sent as itself, only through `toBody`. */
  readonly virtual?: boolean;
}

type Row = { readonly id: string } & Record<string, unknown>;

export function CrudStep(props: {
  api: Api;
  title: string;
  hint: string;
  addLabel: string;
  noun: string;
  resource: string;
  branchId: string | null;
  branchScoped: boolean;
  fields: readonly StepField[];
  columns: readonly Column<Row>[];
  filters?: readonly Filter<Row>[] | undefined;
  empty: string;
  /** Extra values a create sends, e.g. a key derived from the name. */
  onCreate?: (values: Record<string, string>) => Record<string, unknown>;
  disabled?: string | undefined;
  onChanged?: () => void;
  /** Values for virtual fields, read from a row being edited. */
  toForm?: (row: Readonly<Record<string, unknown>>) => Record<string, string>;
  /** Columns written from the form's values (virtual fields included); compared with the row on edit. */
  toBody?: (values: Readonly<Record<string, string>>) => Record<string, string | null>;
}): ReactElement {
  const path = `/admin/${props.resource}`;
  const list = useList<Row>(props.api, props.branchScoped ? withBranch(path, props.branchId) : path);
  const [editing, setEditing] = useState<Row | 'new' | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);

  function open(row: Row | 'new'): void {
    setEditing(row); setTouched(false); setRefusal(null);
    setValues({
      ...Object.fromEntries(props.fields.map((f) => [
        f.name, row === 'new' ? '' : row[f.name] === null || row[f.name] === undefined ? '' : String(row[f.name]),
      ])),
      ...(row === 'new' ? {} : props.toForm?.(row) ?? {}),
    });
  }

  const isNew = editing === 'new';
  const shown = props.fields.filter((f) => f.showIf?.(values) ?? true);
  const missing = shown.filter((f) => f.required && (!f.createOnly || isNew) && (values[f.name] ?? '').trim() === '');
  const problems = new Map(shown.flatMap((f) => {
    const value = (values[f.name] ?? '').trim();
    const problem = value === '' ? null : f.problem?.(value, values) ?? null;
    return problem === null ? [] : [[f, problem] as const];
  }));

  async function save(): Promise<void> {
    setTouched(true);
    if (missing.length > 0 || problems.size > 0 || editing === null) return;
    setBusy(true); setRefusal(null);
    try {
      if (editing === 'new') {
        const body: Record<string, unknown> = {};
        for (const f of shown) if (!f.virtual && (values[f.name] ?? '').trim() !== '') body[f.name] = values[f.name]!.trim();
        for (const [k, v] of Object.entries(props.toBody?.(values) ?? {})) if (v !== null) body[k] = v;
        await props.api.postDetailed(props.branchScoped ? withBranch(path, props.branchId) : path,
          { ...body, ...(props.onCreate?.(values) ?? {}) });
      } else {
        const changed: Record<string, unknown> = {};
        const wanted: Record<string, string | null> = {
          ...Object.fromEntries(shown.filter((f) => !f.createOnly && !f.virtual).map((f) => [f.name, (values[f.name] ?? '').trim()])),
          ...(props.toBody?.(values) ?? {}),
        };
        for (const [k, v] of Object.entries(wanted)) {
          const before = editing[k] === null || editing[k] === undefined ? '' : String(editing[k]);
          const now = v ?? '';
          if (now !== before) changed[k] = now === '' ? null : now;
        }
        if (Object.keys(changed).length > 0) await props.api.patchDetailed(`${path}/${editing.id}`, changed);
      }
      setEditing(null);
      await list.reload();
      props.onChanged?.();
    } catch (error) {
      setRefusal(refusalOf(error));
    } finally {
      setBusy(false);
    }
  }

  async function remove(row: Row): Promise<void> {
    if (!window.confirm(`Remove this ${props.noun}? It is taken out of use, not deleted.`)) return;
    try {
      await props.api.remove(`${path}/${row.id}`);
      await list.reload();
      props.onChanged?.();
    } catch (error) {
      window.alert(refusalOf(error));
    }
  }

  return (
    <section className="flex flex-col gap-3">
      <StepHeader title={props.title} hint={props.hint} addLabel={props.addLabel}
        onAdd={() => open('new')} disabled={props.disabled} />
      <StepTable rows={list.rows} failed={list.failed} columns={props.columns} filters={props.filters} empty={props.empty}
        noun={props.title.toLowerCase()}
        onEdit={open} onRemove={(row) => { void remove(row); }} />
      <FormModal open={editing !== null} busy={busy} onClose={() => setEditing(null)}
        title={isNew ? `Add ${props.noun}` : `Edit ${props.noun}`}
        footer={<ModalFooter busy={busy} saveLabel={isNew ? `Add ${props.noun}` : 'Save changes'}
          onSave={() => { void save(); }} onCancel={() => setEditing(null)} />}>
        <div className="flex flex-col gap-3.5">
          {refusal !== null && <RefusalBanner>{refusal}</RefusalBanner>}
          <div className="grid gap-3.5 sm:grid-cols-2">
            {shown.map((f) => {
              const locked = f.createOnly === true && !isNew;
              const error = touched && missing.includes(f) ? `${f.label} is required.` : problems.get(f) ?? null;
              return (
                <Field key={f.name} label={f.label} required={f.required === true && !locked} hint={locked ? 'Cannot be changed after it is created.' : f.hint} error={error}>
                  {f.type === 'select' ? (
                    <select value={values[f.name] ?? ''} disabled={locked} className={selectClass}
                      onChange={(e) => setValues((v) => ({ ...v, [f.name]: e.target.value }))}>
                      <option value="">{f.required ? `Choose ${f.label.toLowerCase()}` : 'None'}</option>
                      {(f.options ?? []).map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                    </select>
                  ) : (
                    <Input value={values[f.name] ?? ''} disabled={locked} placeholder={f.placeholder}
                      inputMode={f.type === 'number' ? 'numeric' : undefined}
                      aria-invalid={error !== null ? true : undefined}
                      onChange={(e) => setValues((v) => ({ ...v, [f.name]: f.type === 'number' ? e.target.value.replace(/\D/g, '') : e.target.value }))}
                      className="h-10" />
                  )}
                </Field>
              );
            })}
          </div>
        </div>
      </FormModal>
    </section>
  );
}
