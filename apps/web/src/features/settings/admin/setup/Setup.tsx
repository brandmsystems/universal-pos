import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { Api } from '../../../../services/api.js';
import { cn } from '@/lib/utils.js';
import { CrudStep } from './CrudStep.js';
import { KitchensStep } from './KitchensStep.js';
import { PrintAgentPanel } from './PrintAgentPanel.js';
import { ItemsStep } from './ItemsStep.js';
import { ExcelImport } from './ExcelImport.js';
import { keyFrom, selectClass, useList, withBranch } from './common.js';
import { Loading, Skeleton } from '@/components/ui/skeleton.js';
import { PRINTER_DEFAULT_PORT, printerAddress, printerAddressProblem, printerPortProblem } from '@katkitchen/shared';
import { PAPER } from '../../../billing/print/receipt.js';

/**
 * Wi-Fi and Ethernet are one connection to the printer: TCP to an IP address on
 * the restaurant's network. So they are one choice, stored as `network`.
 */
const CONNECTION_OPTIONS = [
  { value: 'bluetooth', label: 'Bluetooth' },
  { value: 'usb', label: 'USB' },
  { value: 'network', label: 'Wi-Fi / Ethernet LAN' },
  { value: 'cloud', label: 'Cloud' },
];
const connectionLabel = (kind: unknown): string => CONNECTION_OPTIONS.find((o) => o.value === kind)?.label ?? String(kind ?? '');
const isNetwork = (v: Readonly<Record<string, string>>): boolean => v['connection_kind'] === 'network';
const ROLLS = (['thermal_58', 'thermal_80', 'thermal_112'] as const).map((p) => ({ value: p, label: PAPER[p].label }));

/**
 * The manager's setup, in the order each step needs the one before: tables sit
 * on floors, a kitchen prints on a printer, a dish is made in a kitchen.
 */

interface Progress {
  readonly floorTypes: number; readonly floors: number; readonly tables: number; readonly kitchens: number;
  readonly printers: number; readonly categories: number; readonly items: number; readonly addOns: number;
}

export type SetupStepId = 'floor-types' | 'floors' | 'tables' | 'printers' | 'kitchens' | 'categories' | 'items';

const ALL_STEPS: readonly { id: SetupStepId; title: string; count: (p: Progress) => number }[] = [
  { id: 'floors', title: 'Floors', count: (p) => p.floors },
  { id: 'floor-types', title: 'Floor types', count: (p) => p.floorTypes },
  { id: 'tables', title: 'Tables', count: (p) => p.tables },
  { id: 'printers', title: 'Printers', count: (p) => p.printers },
  { id: 'kitchens', title: 'Kitchens', count: (p) => p.kitchens },
  { id: 'categories', title: 'Menu categories', count: (p) => p.categories },
  { id: 'items', title: 'Food items', count: (p) => p.items },
];

interface Branch { readonly id: string; readonly name: string; readonly status: string }
interface Named { readonly id: string; readonly name: string }

/** Chooses which branch the setup applies to; one branch needs no choice. */
export function useBranchChoice(api: Api): { branches: readonly Branch[]; branchId: string | null; setBranchId: (id: string) => void } {
  const [branches, setBranches] = useState<readonly Branch[]>([]);
  const [branchId, setBranchId] = useState<string | null>(null);
  useEffect(() => {
    void api.get<{ rows: Branch[] }>('/admin/branches').then((r) => {
      const active = r.rows.filter((b) => b.status === 'active');
      setBranches(active);
      setBranchId((current) => current ?? active[0]?.id ?? null);
    }).catch(() => setBranches([]));
  }, [api]);
  return { branches, branchId, setBranchId };
}

export function BranchPicker(props: { branches: readonly Branch[]; branchId: string | null; onChange: (id: string) => void }): ReactElement | null {
  if (props.branches.length <= 1) return null;
  return (
    <label className="flex items-center gap-2 text-sm">
      <span className="font-semibold text-muted-foreground">Branch</span>
      <select value={props.branchId ?? ''} onChange={(e) => props.onChange(e.target.value)} className={cn(selectClass, 'w-56')}>
        {props.branches.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
      </select>
    </label>
  );
}

export function SetupStep(props: { api: Api; step: SetupStepId; branchId: string | null; onChanged: () => void }): ReactElement | null {
  // Only the floor-plan steps name floors and floor types. Read nowhere else: a plan
  // without tables (Basic) refuses these lists, and every other step would ask anyway.
  const floorPlan = FLOOR_PLAN.has(props.step);
  const floorTypes = useList<Named>(props.api, floorPlan ? '/admin/floor-types' : null);
  const floors = useList<Named>(props.api, floorPlan ? withBranch('/admin/floors', props.branchId) : null);
  const typeName = (id: unknown): string => floorTypes.rows?.find((t) => t.id === id)?.name ?? '—';
  const floorName = (id: unknown): string => floors.rows?.find((f) => f.id === id)?.name ?? '—';
  const common = { api: props.api, branchId: props.branchId, onChanged: props.onChanged };

  switch (props.step) {
    case 'floor-types':
      return (
        <CrudStep {...common} title="Floor types" noun="floor type" addLabel="Add floor type" resource="floor-types"
          branchScoped={false} hint="What kind of area each floor is. AC, Non AC, VIP and Rooftop are ready to use."
          empty="No floor types." fields={[{ name: 'name', label: 'Name', required: true, placeholder: 'Garden' }]}
          onCreate={(v) => ({ key: keyFrom(v['name'] ?? '') })}
          columns={[{ title: 'Floor type', value: (row) => String(row['name'] ?? ''), render: (row) => <span className="font-semibold">{String(row['name'])}</span> }]} />
      );
    case 'floors':
      return (
        <CrudStep {...common} title="Floors" noun="floor" addLabel="Add floor" resource="floors" branchScoped
          hint="The rooms or levels guests sit in — Ground floor, First floor, Terrace." empty="No floors yet."
          fields={[
            { name: 'name', label: 'Floor name', required: true, placeholder: 'Ground floor' },
            { name: 'floor_type_id', label: 'Floor type', type: 'select', options: (floorTypes.rows ?? []).map((t) => ({ value: t.id, label: t.name })) },
            { name: 'display_order', label: 'Order', type: 'number', placeholder: '1' },
          ]}
          columns={[
            { title: 'Floor', value: (row) => String(row['name'] ?? ''), render: (row) => <span className="font-semibold">{String(row['name'])}</span> },
            { title: 'Type', value: (row) => typeName(row['floor_type_id']), render: (row) => typeName(row['floor_type_id']) },
          ]}
          filters={[{ kind: 'choice', label: 'Floor type', value: (row) => typeName(row['floor_type_id']) }]} />
      );
    case 'tables':
      return (
        <CrudStep {...common} title="Tables" noun="table" addLabel="Add table" resource="tables" branchScoped
          hint="Each table, the floor it is on and how many it seats." empty="No tables yet."
          disabled={floors.rows !== null && floors.rows.length === 0 ? 'Add a floor first — every table is on one.' : undefined}
          fields={[
            { name: 'floor_id', label: 'Floor', required: true, type: 'select', options: (floors.rows ?? []).map((f) => ({ value: f.id, label: f.name })) },
            { name: 'identifier', label: 'Table name', required: true, placeholder: 'T1' },
            { name: 'seats', label: 'Seats', required: true, type: 'number', placeholder: '4' },
          ]}
          columns={[
            { title: 'Table', value: (row) => String(row['identifier'] ?? ''), render: (row) => <span className="font-semibold">{String(row['identifier'])}</span> },
            { title: 'Floor', value: (row) => floorName(row['floor_id']), render: (row) => floorName(row['floor_id']) },
            { title: 'Seats', value: (row) => Number(row['seats']), render: (row) => String(row['seats']) },
          ]}
          filters={[
            { kind: 'choice', label: 'Floor', value: (row) => floorName(row['floor_id']) },
            { kind: 'choice', label: 'Seats', value: (row) => String(row['seats']) },
            { kind: 'choice', label: 'Status', value: (row) => String(row['status'] ?? '') },
          ]} />
      );
    case 'printers':
      return (
        <div className="flex flex-col gap-4">
        <CrudStep {...common} title="Printers" noun="printer" addLabel="Add printer" resource="printers" branchScoped
          hint="The printers kitchen tickets and bills come out of." empty="No printers yet."
          fields={[
            { name: 'name', label: 'Printer name', required: true, placeholder: 'Kitchen printer' },
            { name: 'connection_kind', label: 'Connection type', required: true, type: 'select', createOnly: true,
              options: CONNECTION_OPTIONS },
            { name: 'ip', label: 'IP address', required: true, virtual: true, placeholder: '192.168.1.50', showIf: isNetwork,
              problem: (ip) => (ip.includes(':') ? 'Type the port in the TCP port field.' : printerAddressProblem(ip)),
              hint: 'The address on the printer’s self-test slip (hold FEED while switching it on). Give it a fixed address in the router, or tickets stop when it changes.' },
            { name: 'port', label: 'TCP port', virtual: true, type: 'number', placeholder: String(PRINTER_DEFAULT_PORT), showIf: isNetwork,
              problem: (port) => printerPortProblem(port),
              hint: `Leave empty for ${PRINTER_DEFAULT_PORT}, which almost every receipt printer uses.` },
            { name: 'paper_size', label: 'Paper', type: 'select', showIf: isNetwork, options: ROLLS,
              hint: 'A network printer is a receipt printer. For USB and Bluetooth, set the paper on the Printed bill page.' },
          ]}
          toForm={(row) => {
            const parsed = typeof row['address'] === 'string' ? /^([^:]*)(?::(.*))?$/.exec(row['address']) : null;
            return { ip: parsed?.[1] ?? '', port: parsed?.[2] ?? '' };
          }}
          toBody={(v) => (isNetwork(v) ? { address: (v['ip'] ?? '').trim() === '' ? null : printerAddress(v['ip']!, v['port'] ?? '') } : {})}
          columns={[
            { title: 'Printer', value: (row) => String(row['name'] ?? ''), render: (row) => <span className="font-semibold">{String(row['name'])}</span> },
            { title: 'Connection', value: (row) => connectionLabel(row['connection_kind']), render: (row) => connectionLabel(row['connection_kind']) },
            { title: 'Address', value: (row) => String(row['address'] ?? ''), render: (row) => <span className="font-mono text-xs">{row['connection_kind'] === 'network' ? String(row['address'] ?? '—') : '—'}</span> },
          ]}
          filters={[
            { kind: 'choice', label: 'Connection', value: (row) => connectionLabel(row['connection_kind']) },
            { kind: 'choice', label: 'Status', value: (row) => String(row['status'] ?? '') },
          ]} />
        <PrintAgentPanel api={props.api} branchId={props.branchId} />
        </div>
      );
    case 'kitchens':
      return <KitchensStep {...common} />;
    case 'categories':
      return (
        <CrudStep {...common} title="Menu categories" noun="category" addLabel="Add category" resource="menu/categories"
          branchScoped={false} hint="How the menu is grouped — Starters, Mains, Beverages." empty="No categories yet."
          fields={[
            { name: 'name', label: 'Category name', required: true, placeholder: 'Starters' },
            { name: 'display_order', label: 'Order', type: 'number', placeholder: '1' },
          ]}
          onCreate={(v) => ({ key: keyFrom(v['name'] ?? '') })}
          columns={[{ title: 'Category', value: (row) => String(row['name'] ?? ''), render: (row) => <span className="font-semibold">{String(row['name'])}</span> }]} />
      );
    case 'items':
      return <ItemsStep {...common} />;
    default:
      return null;
  }
}

/** The floor plan's steps: a plan without tables (Basic) has none of them. */
const FLOOR_PLAN: ReadonlySet<SetupStepId> = new Set(['floors', 'floor-types', 'tables']);

export function Setup(props: { api: Api; tables?: boolean }): ReactElement {
  const STEPS = useMemo(() => (props.tables === false ? ALL_STEPS.filter((s) => !FLOOR_PLAN.has(s.id)) : ALL_STEPS),
    [props.tables]);
  const { branches, branchId, setBranchId } = useBranchChoice(props.api);
  const [step, setStep] = useState<SetupStepId>(STEPS[0]!.id);
  useEffect(() => { if (!STEPS.some((s) => s.id === step)) setStep(STEPS[0]!.id); }, [STEPS, step]);
  const [progress, setProgress] = useState<Progress | null>(null);
  // Answered at least once, either way: until then the counts are unknown, not zero.
  const [progressRead, setProgressRead] = useState(false);

  const readProgress = useCallback(async (): Promise<void> => {
    try { setProgress(await props.api.get<Progress>(withBranch('/admin/setup', branchId))); } catch { setProgress(null); }
    setProgressRead(true);
  }, [props.api, branchId]);
  useEffect(() => { void readProgress(); }, [readProgress]);

  const index = STEPS.findIndex((s) => s.id === step);
  const done = progress === null ? 0 : STEPS.filter((s) => s.count(progress) > 0).length;

  return (
    <div className="flex flex-col gap-5">
      <header className="flex flex-wrap items-center gap-4">
        <div className="flex flex-col gap-0.5">
          <h1 className="m-0 text-[22px] font-bold tracking-tight">Restaurant setup</h1>
          {progressRead
            ? <span className="text-[13px] text-muted-foreground">{done} of {STEPS.length} steps done</span>
            : <Loading label="setup progress" className="py-0.5"><Skeleton className="h-4 w-28" /></Loading>}
        </div>
        <div className="ml-auto"><BranchPicker branches={branches} branchId={branchId} onChange={setBranchId} /></div>
      </header>

      <ExcelImport api={props.api} branchId={branchId} onImported={() => { void readProgress(); }} />

      <ol className="grid gap-2 sm:grid-cols-4 lg:grid-cols-7">
        {STEPS.map((s, i) => {
          const count = progress === null ? 0 : s.count(progress);
          const active = s.id === step;
          return (
            <li key={s.id}>
              <button type="button" onClick={() => setStep(s.id)} aria-current={active ? 'step' : undefined}
                className={cn('flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm',
                  active ? 'border-primary bg-accent font-bold' : 'border-border bg-card')}>
                <span className={cn('flex size-6 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                  count > 0 ? 'bg-primary text-primary-foreground' : 'bg-muted text-muted-foreground')}>
                  {count > 0 ? '✓' : i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate">{s.title}</span>
                  {progressRead
                    ? <span className="block text-[11px] font-normal text-muted-foreground">{count} added</span>
                    : <Skeleton className="skeleton-appear mt-1 h-3 w-12" />}
                </span>
              </button>
            </li>
          );
        })}
      </ol>

      <div className="rounded-lg border border-border bg-card p-5">
        <SetupStep key={`${step}-${branchId ?? ''}`} api={props.api} step={step} branchId={branchId}
          onChanged={() => { void readProgress(); }} />
      </div>

      {index < STEPS.length - 1 && (
        <div className="flex justify-end">
          <button type="button" onClick={() => setStep(STEPS[index + 1]!.id)}
            className="h-10 rounded-md bg-brand-gradient px-5 font-bold text-primary-foreground hover:opacity-90">
            Next: {STEPS[index + 1]!.title} →
          </button>
        </div>
      )}
    </div>
  );
}

/** One setup step on its own sidebar screen, with the branch choice beside it. */
export function StepScreen(props: { api: Api; step: SetupStepId }): ReactElement {
  const { branches, branchId, setBranchId } = useBranchChoice(props.api);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex justify-end"><BranchPicker branches={branches} branchId={branchId} onChange={setBranchId} /></div>
      <SetupStep key={`${props.step}-${branchId ?? ''}`} api={props.api} step={props.step} branchId={branchId} onChanged={() => undefined} />
    </div>
  );
}
