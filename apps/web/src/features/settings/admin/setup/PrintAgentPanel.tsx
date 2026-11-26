import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import type { Api } from '../../../../services/api.js';
import { Input } from '@/components/ui/input.js';
import { RefusalBanner } from '../../../../components/admin/banner.js';
import { refusalOf, withBranch } from './common.js';
import agentFileUrl from '../../../../../../print-agent/katkitchen-print-agent.mjs?url';

/**
 * The print agent: what prints kitchen tickets on Wi-Fi and Ethernet printers,
 * which the hosted server cannot reach. A manager sets one up per branch, copies
 * its token once, and sees here what the agent last saw of each printer.
 */

interface Agent {
  readonly id: string;
  readonly name: string;
  readonly last_seen_at: string | null;
  readonly agent_version: string | null;
  readonly online: boolean;
}

interface Printer {
  readonly id: string;
  readonly name: string;
  readonly connection_kind: string;
  readonly address: string | null;
  readonly status: string;
  readonly reach_checked_at: string | null;
  readonly reachable: boolean | null;
  readonly reach_error: string | null;
  readonly test_print_requested_at: string | null;
  readonly test_printed_at: string | null;
  readonly test_print_error: string | null;
}

const ago = (iso: string | null): string => {
  if (iso === null) return 'never';
  const seconds = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (seconds < 60) return `${seconds} s ago`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  return new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
};

const BUTTON = 'h-10 rounded-[10px] border border-input bg-card px-4 text-sm font-semibold disabled:opacity-50';
const PRIMARY = 'h-10 rounded-[10px] bg-primary px-4 text-sm font-semibold text-white disabled:opacity-50';

export function PrintAgentPanel(props: { api: Api; branchId: string | null }): ReactElement {
  const [agents, setAgents] = useState<readonly Agent[] | null>(null);
  const [printers, setPrinters] = useState<readonly Printer[]>([]);
  const [name, setName] = useState('Till PC');
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const reload = useCallback(async (): Promise<void> => {
    try {
      const [a, p] = await Promise.all([
        props.api.get<{ agents: Agent[] }>(withBranch('/admin/print-agents', props.branchId)),
        props.api.get<{ rows: Printer[] }>(withBranch('/admin/printers', props.branchId)),
      ]);
      setAgents(a.agents ?? []);
      setPrinters((p.rows ?? []).filter((x) => x.connection_kind === 'network' && x.status === 'active'));
    } catch (error) {
      setRefusal(refusalOf(error));
    }
  }, [props.api, props.branchId]);

  // The agent reports every few seconds; the page follows it while it is open
  // and shown, one read at a time, and catches up at once when shown again.
  const reading = useRef(false);
  useEffect(() => {
    const tick = (): void => {
      if (reading.current || document.visibilityState === 'hidden') return;
      reading.current = true;
      void reload().finally(() => { reading.current = false; });
    };
    const onVisible = (): void => { if (document.visibilityState === 'visible') tick(); };
    tick();
    const timer = setInterval(tick, 5000);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [reload]);

  async function run(work: () => Promise<unknown>): Promise<void> {
    setBusy(true); setRefusal(null);
    try { await work(); await reload(); } catch (error) { setRefusal(refusalOf(error)); } finally { setBusy(false); }
  }

  const issue = (): Promise<void> => run(async () => {
    const made = await props.api.postDetailed<{ name: string; token: string }>(withBranch('/admin/print-agents', props.branchId), { name });
    setIssued({ name: made.name, token: made.token });
  });
  const revoke = (agent: Agent): Promise<void> => {
    if (!window.confirm(`Stop "${agent.name}"? It stops printing at its next check, and needs a new token to start again.`)) return Promise.resolve();
    return run(() => props.api.remove(withBranch(`/admin/print-agents/${agent.id}`, props.branchId)));
  };
  const testPrint = (printer: Printer): Promise<void> =>
    run(() => props.api.postDetailed(withBranch(`/admin/printers/${printer.id}/test-print`, props.branchId), {}));

  const config = issued === null ? '' : JSON.stringify({ server: window.location.origin, token: issued.token }, null, 2);
  const live = (agents ?? []).some((a) => a.online);

  return (
    <section aria-labelledby="print-agent" className="flex flex-col gap-3 rounded-xl border border-border bg-card p-4">
      <div>
        <h3 id="print-agent" className="m-0 text-base font-semibold">Print agent for Wi-Fi and Ethernet printers</h3>
        <p className="m-0 mt-1 text-sm text-muted-foreground text-pretty">
          Kitchen tickets for a Wi-Fi or Ethernet printer are printed by a small program on a computer in the restaurant,
          on the same network as the printers. It connects out to KatKitchen; nothing is opened to the internet. USB and
          Bluetooth printers do not need it: they connect on the till.
        </p>
      </div>
      {refusal !== null && <RefusalBanner>{refusal}</RefusalBanner>}

      {agents !== null && agents.length > 0 && (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {agents.map((agent) => (
            <li key={agent.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
              <span aria-hidden className={`size-2.5 rounded-full ${agent.online ? 'bg-[#2E9E5B]' : 'bg-muted-foreground'}`} />
              <span className="font-semibold">{agent.name}</span>
              <span className="text-muted-foreground">
                {agent.online ? 'Online' : 'Offline'} · last seen {ago(agent.last_seen_at)}{agent.agent_version ? ` · v${agent.agent_version}` : ''}
              </span>
              <button type="button" disabled={busy} onClick={() => void revoke(agent)}
                className="text-xs font-semibold text-destructive underline-offset-2 hover:underline disabled:opacity-50">Stop this agent</button>
            </li>
          ))}
        </ul>
      )}
      {agents !== null && agents.length > 0 && !live && (
        <p role="status" className="m-0 text-sm font-semibold text-destructive">
          No print agent is running. Kitchen tickets for this branch&apos;s Wi-Fi and Ethernet printers wait until it is.
        </p>
      )}

      {issued !== null ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3 text-sm">
          <p className="m-0 font-semibold">“{issued.name}” is set up. Copy this now: it is shown only once.</p>
          <ol className="m-0 flex flex-col gap-1 pl-5">
            <li>On the restaurant computer, install Node.js 22 or newer (nodejs.org).</li>
            <li>Make a folder, for example <code>C:\KatKitchen</code>, and save the <a href={agentFileUrl} download="katkitchen-print-agent.mjs" className="font-semibold text-primary underline">print agent file</a> in it.</li>
            <li>In the same folder, save this as <code>agent.json</code>:</li>
          </ol>
          <pre className="m-0 overflow-x-auto rounded-md bg-card p-2 text-xs">{config}</pre>
          <div className="flex flex-wrap gap-2">
            <button type="button" className={BUTTON} onClick={() => { void navigator.clipboard?.writeText(config); }}>Copy agent.json</button>
            <button type="button" className={BUTTON} onClick={() => setIssued(null)}>Done</button>
          </div>
          <p className="m-0 text-muted-foreground">
            Then run <code>node katkitchen-print-agent.mjs --check</code> in that folder: it lists the printers and whether each
            answers. To start it with Windows, see the setup guide (katkitchen.md, section 5.5).
          </p>
        </div>
      ) : (
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); void issue(); }}>
          <label className="flex min-w-0 flex-col gap-1 text-sm">
            <span className="font-semibold">Computer it runs on</span>
            <Input value={name} maxLength={60} onChange={(e) => setName(e.target.value)} className="h-10 w-56 max-w-full" />
          </label>
          <button type="submit" disabled={busy || name.trim() === ''} className={agents !== null && agents.length > 0 ? BUTTON : PRIMARY}>
            {agents !== null && agents.length > 0 ? 'Set up another agent' : 'Set up print agent'}
          </button>
        </form>
      )}

      {printers.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="m-0 text-sm font-semibold">Wi-Fi and Ethernet printers at this branch</h4>
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {printers.map((printer) => (
              <li key={printer.id} className="flex flex-col gap-1 rounded-lg border border-border p-3 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0">
                  <div><span className="font-semibold">{printer.name}</span> <span className="font-mono text-xs text-muted-foreground">{printer.address ?? '—'}</span></div>
                  <div className={printer.reachable === false ? 'text-destructive' : 'text-muted-foreground'}>
                    {printer.reachable === null ? 'Not checked by a print agent yet.'
                      : printer.reachable ? `Answers on the network · checked ${ago(printer.reach_checked_at)}`
                        : `Does not answer: ${printer.reach_error ?? 'no reason given'} · checked ${ago(printer.reach_checked_at)}`}
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {printer.test_print_requested_at !== null ? 'Test print waiting for the print agent…'
                      : printer.test_print_error !== null ? <span className="text-destructive">Last test print failed: {printer.test_print_error}</span>
                        : printer.test_printed_at !== null ? `Last test print sent ${ago(printer.test_printed_at)}` : ''}
                  </div>
                </div>
                <button type="button" disabled={busy || printer.test_print_requested_at !== null} onClick={() => void testPrint(printer)} className={BUTTON}>
                  Test print
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
