import { useEffect, useState, useSyncExternalStore } from 'react';
import { Printer } from 'lucide-react';
import type { ReactElement } from 'react';
import { cn } from 'cn';
import { receiptPrinter, type PrinterState, type PrinterView, type ReceiptPrinter, type SavedPrinter } from './serialPrinter.js';

export function usePrinterView(printer: ReceiptPrinter): PrinterView {
  return useSyncExternalStore(printer.subscribe, printer.view);
}

/** Connected / Disconnected / Connecting / Error: the four words the panel and the header use. */
const STATUS: Record<PrinterState['kind'], string> = {
  unsupported: 'Print dialog',
  disconnected: 'Disconnected',
  connecting: 'Connecting…',
  ready: 'Connected',
  printing: 'Printing…',
  error: 'Error',
};

const KIND: Record<SavedPrinter['kind'], string> = { bluetooth: 'Bluetooth', usb: 'USB', serial: 'COM port' };
const CONNECTION: Record<string, string> = { bluetooth: 'Bluetooth', usb: 'USB', network: 'Wi-Fi / Ethernet LAN', cloud: 'Cloud' };

function sentence(state: PrinterState): string {
  switch (state.kind) {
    case 'unsupported':
      return 'This browser cannot write to a receipt printer directly. That needs Chrome or Edge on a computer or on Android, '
        + 'over https or on this computer; iPhone and iPad browsers cannot. Bills print through the print dialog.';
    case 'disconnected':
      return `${state.message ? `${state.message} ` : ''}Bills print through the print dialog until a printer is connected.`;
    case 'connecting': return 'Connecting to the printer…';
    case 'ready': return 'Bills for a USB or Bluetooth printer print here directly.';
    case 'printing': return `Printing copy ${state.copy} of ${state.of}…`;
    case 'error': return state.message;
  }
}

const when = (iso: string): string => new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });

const BUTTON = 'h-10 rounded-[10px] border border-input bg-card px-4 font-semibold disabled:opacity-50';
const PRIMARY = 'h-10 rounded-[10px] bg-primary px-4 font-semibold text-white disabled:opacity-50';

/**
 * This till's receipt printer: search, the saved list, connect, disconnect,
 * reconnect, a test slip, the cutter switch and what the last print did.
 * Compact in the POS header (a button that opens the panel); in full on the
 * Printed bill page. Which kind of printer to look for is the branch's bill
 * printer setting -- `connection` when the page knows it, else what the last
 * bill this till printed said -- and is changed under Printed bill, not here.
 */
export function PrinterConnection(props: { printer?: ReceiptPrinter; compact?: boolean; connection?: string | null }): ReactElement {
  const printer = props.printer ?? receiptPrinter();
  const view = usePrinterView(printer);
  const { state } = view;
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [naming, setNaming] = useState<string | null>(null);
  const [checked, setChecked] = useState<{ readonly ok: boolean; readonly message: string } | null>(null);
  const connection = props.connection !== undefined ? props.connection : view.branchConnection;

  // Opening the panel re-reads the allowed ports: another tab may have added or forgotten one.
  useEffect(() => { if (!props.compact || open) void printer.refresh(); }, [printer, props.compact, open]);

  const working = state.kind === 'connecting' || state.kind === 'printing';
  const selected = view.saved.find((s) => s.id === picked) ?? view.current ?? view.remembered ?? view.saved[0] ?? null;
  const selectedInUse = selected !== null && view.current?.id === selected.id;
  const connected = state.kind === 'ready' || state.kind === 'printing';
  const tone = connected ? 'bg-[#2E9E5B]' : state.kind === 'error' ? 'bg-destructive' : 'bg-muted-foreground';
  const searchBluetooth = connection !== 'usb';
  const searchCom = connection !== 'bluetooth';

  const panel = (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span aria-hidden className={cn('size-2.5 rounded-full', tone)} />
        <span className="font-semibold">{STATUS[state.kind]}</span>
        {view.current !== null && <span className="min-w-0 truncate text-muted-foreground">· {view.current.name}</span>}
      </div>
      <p role={state.kind === 'error' ? 'alert' : 'status'} className={cn('m-0 text-pretty', state.kind === 'error' && 'font-semibold text-destructive')}>
        {sentence(state)}
      </p>

      {connection !== null && connection !== undefined && (
        <p className="m-0 text-xs text-muted-foreground">
          This branch prints bills on: <span className="font-semibold text-foreground">{CONNECTION[connection] ?? connection}</span>
          {' '}(set on the Printed bill page).
        </p>
      )}

      {state.kind !== 'unsupported' && (connection === 'network' || connection === 'cloud') && (
        <p className="m-0 text-pretty text-muted-foreground">
          Nothing to connect on this till. Kitchen tickets go to that printer from the UniversalPOS server, which reaches it
          only when the server is on the restaurant&apos;s own network: the hosted site cannot reach a printer at a
          192.168… address yet. Bills print through this computer&apos;s print dialog.
        </p>
      )}

      {state.kind !== 'unsupported' && connection !== 'network' && connection !== 'cloud' && (
        <>
          {view.saved.length > 0 && (
            <label className="flex flex-col gap-1">
              <span className="text-xs font-semibold">Saved printers in this browser</span>
              <select value={selected?.id ?? ''} disabled={working} onChange={(e) => { setPicked(e.target.value); setNaming(null); }}
                className="h-10 rounded-md border border-border bg-card px-2 text-sm disabled:opacity-50">
                {view.saved.map((s) => (
                  <option key={s.id} value={s.id}>{s.name} · {KIND[s.kind]}{view.current?.id === s.id ? ' · in use' : ''}</option>
                ))}
              </select>
              {selected !== null && (
                <span className="text-xs text-muted-foreground">
                  {selected.lastConnectedAt === null ? 'Not connected on this till yet.' : `Last connected ${when(selected.lastConnectedAt)}.`}
                </span>
              )}
            </label>
          )}

          <div className="flex flex-wrap gap-2">
            {selected !== null && (selectedInUse && connected
              ? <button type="button" disabled={working} onClick={() => void printer.disconnect()} className={BUTTON}>Disconnect</button>
              : <button type="button" disabled={working} onClick={() => void printer.select(selected.id)} className={PRIMARY}>Connect</button>)}
            {view.remembered !== null && (state.kind === 'error' || (state.kind === 'disconnected' && view.current !== null)) && (
              <button type="button" disabled={working} onClick={() => void printer.reconnect()} className={BUTTON}>Reconnect</button>
            )}
            {connected && (
              <button type="button" disabled={working} onClick={() => { setChecked(null); void printer.testConnection().then(setChecked); }}
                className={BUTTON}>Test connection</button>
            )}
            {connected && (
              <button type="button" disabled={working} onClick={() => { setChecked(null); void printer.testPrint(); }} className={BUTTON}>Test print</button>
            )}
          </div>
          {checked !== null && checked.ok && <p role="status" className="m-0 text-xs font-semibold text-[#2E9E5B]">{checked.message}</p>}

          <div className="flex flex-wrap gap-2">
            {searchBluetooth && (
              <button type="button" disabled={working} onClick={() => void printer.connect('bluetooth')}
                className={view.saved.length === 0 ? PRIMARY : BUTTON}>
                Search Bluetooth devices
              </button>
            )}
            {searchCom && (
              <button type="button" disabled={working} onClick={() => void printer.connect('any')}
                className={view.saved.length === 0 && !searchBluetooth ? PRIMARY : BUTTON}>
                {searchBluetooth ? 'Choose a USB or COM port' : 'Choose a USB printer'}
              </button>
            )}
          </div>

          {selected !== null && (naming === selected.id ? (
            <form className="flex gap-2" onSubmit={(e) => {
              e.preventDefault();
              printer.rename(selected.id, new FormData(e.currentTarget).get('name') as string);
              setNaming(null);
            }}>
              <input name="name" defaultValue={selected.name} maxLength={40} aria-label="Printer name" autoFocus
                className="h-10 min-w-0 flex-1 rounded-md border border-border bg-card px-2 text-sm" />
              <button type="submit" className={BUTTON}>Save</button>
            </form>
          ) : (
            <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
              <button type="button" onClick={() => setNaming(selected.id)} className="font-semibold text-primary underline-offset-2 hover:underline">
                Rename
              </button>
              <button type="button" disabled={working} onClick={() => { setPicked(null); void printer.forget(selected.id); }}
                className="font-semibold text-destructive underline-offset-2 hover:underline disabled:opacity-50">
                Forget this printer
              </button>
            </div>
          ))}

          <p className="m-0 text-xs text-muted-foreground">
            Last successful print: {view.lastSuccessAt === null ? 'none on this till yet' : when(view.lastSuccessAt)}
          </p>

          {view.lastJob !== null && (
            <p role={view.lastJob.status === 'incomplete' ? 'alert' : undefined}
              className={cn('m-0 text-xs text-pretty', view.lastJob.status === 'incomplete' ? 'text-destructive' : 'text-muted-foreground')}>
              Last print {when(view.lastJob.at)} (job {view.lastJob.id.slice(0, 8)}):{' '}
              {view.lastJob.status === 'sending' ? `sending ${view.lastJob.copies} ${view.lastJob.copies === 1 ? 'copy' : 'copies'}…`
                : view.lastJob.status === 'sent' ? `${view.lastJob.copies} ${view.lastJob.copies === 1 ? 'copy' : 'copies'} sent. Check the paper: the printer cannot say whether it printed.`
                  : `not every copy was sent. ${view.lastJob.message ?? ''}`}
            </p>
          )}

          <label className="flex items-center gap-2">
            <input type="checkbox" checked={view.cuts} onChange={(e) => printer.setCuts(e.target.checked)} />
            Cut the paper after each copy (only if the printer has a cutter)
          </label>
          <p className="m-0 text-xs text-muted-foreground text-pretty">
            Search opens the browser&apos;s own list; the page sees only the printer you pick there. On Windows, pair a
            Bluetooth printer in Settings first; it may be listed as a COM port. On Android, Chrome lists nearby
            Bluetooth printers itself. A USB printer is listed only if it has a COM port; otherwise bills print through
            the print dialog.
          </p>
        </>
      )}
    </div>
  );

  if (!props.compact) return panel;
  return (
    <div className="relative">
      <button type="button" aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="flex h-10 items-center gap-2 rounded-[10px] border border-input bg-card px-3 font-sans text-[15px] font-semibold transition-colors hover:bg-background sm:h-11 sm:px-4">
        <Printer aria-hidden className="size-4" />
        <span aria-hidden className={cn('size-2 rounded-full', tone)} />
        <span className="hidden sm:inline">{state.kind === 'unsupported' ? 'Print dialog' : `Printer: ${STATUS[state.kind]}`}</span>
      </button>
      {open && (
        <div className="absolute right-0 top-full z-30 mt-2 max-h-[80vh] w-[min(360px,calc(100vw-32px))] overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-xl">
          {panel}
        </div>
      )}
    </div>
  );
}
