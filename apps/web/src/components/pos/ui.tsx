import type { ReactNode, ReactElement } from 'react';

/**
 * A modal-ish panel over the pane that opened it.
 *
 * Not a dialog element and not a portal: the POS is one full-screen document per
 * device and a sheet that can be scrolled away from its own Cancel button is how
 * a tablet gets stuck mid-service. Fixed, its own scroll, and the close control
 * is pinned in the header.
 */
export function Sheet(props: {
  title: string;
  subtitle?: string;
  onClose: () => void;
  children: ReactNode;
}): ReactElement {
  return (
    <div
      role="dialog"
      aria-label={props.title}
      className="fixed inset-0 z-20 flex justify-end bg-black/35"
    >
      <div className="flex w-[min(560px,100%)] flex-col bg-background shadow-[-2px_0_0_0_#111111]">
        <div className="flex shrink-0 items-center gap-3.5 border-b border-border bg-card px-5 py-4">
          <div className="flex grow flex-col gap-0.5">
            <span className="text-[19px] font-bold tracking-[-0.3px]">{props.title}</span>
            {props.subtitle !== undefined && (
              <span className="text-[13px] text-muted-foreground">{props.subtitle}</span>
            )}
          </div>
          <button type="button" onClick={props.onClose}
            className="h-11 shrink-0 rounded-[10px] border-[1.5px] border-foreground bg-card px-4 font-sans text-[15px] font-semibold">
            Close
          </button>
        </div>
        <div className="flex grow flex-col gap-4 overflow-y-auto p-5">
          {props.children}
        </div>
      </div>
    </div>
  );
}
