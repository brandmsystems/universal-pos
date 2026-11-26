import { useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { SETUP_SHEETS, type SetupSheetKey, type SetupSheets } from '@universalpos/shared';
import type { Api } from '../../../../services/api.js';
import { Button } from '@/components/ui/button.js';
import { refusalOf, withBranch } from './common.js';
import { TEMPLATE_FILE, buildTemplate, readWorkbook, type FileProblem } from './excel.js';

/**
 * Set the restaurant up from one Excel file: download the template, fill it,
 * upload it, check the preview, import. The preview is the server running the
 * real import and rolling it back, so it cannot promise something the import
 * then refuses.
 */

interface Result {
  readonly applied: boolean;
  readonly counts: Readonly<Record<SetupSheetKey, { created: number; updated: number }>>;
  readonly errors: readonly FileProblem[];
}

const MAX_BYTES = 5 * 1024 * 1024;

type State =
  | { at: 'idle' }
  | { at: 'busy'; doing: string }
  | { at: 'preview'; file: string; sheets: SetupSheets; result: Result }
  | { at: 'done'; result: Result }
  | { at: 'refused'; message: string; problems: readonly FileProblem[] };

export function ExcelImport(props: { api: Api; branchId: string | null; onImported: () => void }): ReactElement {
  const [state, setState] = useState<State>({ at: 'idle' });
  const input = useRef<HTMLInputElement>(null);
  const path = (suffix: string): string => withBranch(`/admin/setup/import${suffix}`, props.branchId);

  async function download(): Promise<void> {
    const X = await import('xlsx');
    X.writeFile(buildTemplate(X), TEMPLATE_FILE);
  }

  async function upload(file: File): Promise<void> {
    if (file.size > MAX_BYTES) {
      setState({ at: 'refused', message: 'That file is larger than 5 MB. A setup file is much smaller; check it is the right one.', problems: [] });
      return;
    }
    setState({ at: 'busy', doing: 'Reading the file…' });
    let read: ReturnType<typeof readWorkbook>;
    try {
      const X = await import('xlsx');
      read = readWorkbook(X, await file.arrayBuffer());
    } catch {
      setState({ at: 'refused', message: 'This file could not be read as Excel (.xlsx or .xls).', problems: [] });
      return;
    }
    if (read.problems.length > 0) {
      setState({ at: 'refused', message: 'Fix these in the file and upload it again.', problems: read.problems });
      return;
    }
    setState({ at: 'busy', doing: 'Checking every row…' });
    try {
      const result = await props.api.postDetailed<Result>(path('/preview'), { sheets: read.sheets });
      setState({ at: 'preview', file: file.name, sheets: read.sheets, result });
    } catch (error) {
      setState({ at: 'refused', message: refusalOf(error), problems: [] });
    }
  }

  async function confirm(sheets: SetupSheets): Promise<void> {
    setState({ at: 'busy', doing: 'Importing…' });
    try {
      const result = await props.api.postDetailed<Result>(path(''), { sheets });
      setState(result.applied ? { at: 'done', result } : { at: 'refused', message: 'Nothing was imported.', problems: result.errors });
      if (result.applied) props.onImported();
    } catch (error) {
      setState({ at: 'refused', message: refusalOf(error), problems: [] });
    }
  }

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex flex-col gap-0.5">
          <h2 className="m-0 text-base font-bold">Set up from Excel</h2>
          <span className="text-[13px] text-muted-foreground">
            Floors, tables, printers, kitchens, categories and menu items in one file. Uploading again updates by name.
          </span>
        </div>
        <div className="ml-auto flex gap-2">
          <Button type="button" variant="outline" onClick={() => void download()}>Download template</Button>
          <Button type="button" disabled={state.at === 'busy' || props.branchId === null} onClick={() => input.current?.click()}>
            Upload Excel
          </Button>
          <input ref={input} type="file" accept=".xlsx,.xls" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void upload(f); }} />
        </div>
      </div>

      {state.at === 'busy' && <span className="text-sm text-muted-foreground">{state.doing}</span>}

      {state.at === 'refused' && (
        <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
          <span className="font-semibold text-destructive">{state.message}</span>
          <Problems problems={state.problems} />
        </div>
      )}

      {state.at === 'preview' && (
        <div className="flex flex-col gap-3">
          <span className="text-sm">Preview of <b>{state.file}</b>. Nothing has been saved yet.</span>
          <Counts counts={state.result.counts} />
          {state.result.errors.length > 0 ? (
            <div className="flex flex-col gap-2 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm">
              <span className="font-semibold text-destructive">
                {state.result.errors.length} problem{state.result.errors.length === 1 ? '' : 's'} to fix. Nothing is imported until every row is right.
              </span>
              <Problems problems={state.result.errors} />
            </div>
          ) : (
            <span className="text-sm font-semibold text-emerald-700">Every row is valid.</span>
          )}
          <div className="flex gap-2">
            <Button type="button" disabled={state.result.errors.length > 0} onClick={() => void confirm(state.sheets)}>Import</Button>
            <Button type="button" variant="outline" onClick={() => setState({ at: 'idle' })}>Cancel</Button>
          </div>
        </div>
      )}

      {state.at === 'done' && (
        <div className="flex flex-col gap-2 rounded-md border border-emerald-600/40 bg-emerald-50 p-3 text-sm">
          <span className="font-semibold text-emerald-800">Imported.</span>
          <Counts counts={state.result.counts} />
        </div>
      )}
    </section>
  );
}

function Counts(props: { counts: Result['counts'] }): ReactElement {
  const rows = SETUP_SHEETS.map((s) => ({ title: s.title, ...props.counts[s.key] }))
    .filter((r) => r.created + r.updated > 0);
  if (rows.length === 0) return <span className="text-sm text-muted-foreground">No rows to import.</span>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full max-w-md text-sm">
        <thead><tr className="text-left text-xs uppercase tracking-wider text-muted-foreground">
          <th className="py-1">Sheet</th><th className="py-1">Added</th><th className="py-1">Updated</th>
        </tr></thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.title} className="border-t border-border">
              <td className="py-1">{r.title}</td><td className="py-1 font-mono">{r.created}</td><td className="py-1 font-mono">{r.updated}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Problems(props: { problems: readonly FileProblem[] }): ReactElement | null {
  if (props.problems.length === 0) return null;
  return (
    <ul className="flex max-h-64 flex-col gap-1 overflow-y-auto">
      {props.problems.map((p, i) => (
        <li key={i}>
          <span className="font-semibold">{p.sheet}{p.row !== null ? `, row ${p.row}` : ''}:</span> {p.message}
        </li>
      ))}
    </ul>
  );
}
