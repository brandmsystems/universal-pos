import { useEffect, useRef } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { cn } from '@/lib/utils.js';

/**
 * A popup for adding or editing one thing. Escape and the backdrop close it,
 * except while a save is in flight: closing mid-request would leave the
 * manager unsure whether the change landed.
 */
export function FormModal(props: {
  open: boolean;
  title: string;
  description?: string | undefined;
  busy?: boolean | undefined;
  wide?: boolean | undefined;
  onClose: () => void;
  footer?: ReactNode;
  children: ReactNode;
}): ReactElement | null {
  const panel = useRef<HTMLDivElement>(null);
  // Refs, not effect dependencies: a parent re-renders on every keystroke and
  // passes a new `onClose` each time, which would re-run the effect and pull
  // focus back to the first field mid-typing.
  const onClose = useRef(props.onClose);
  const busy = useRef(props.busy);
  onClose.current = props.onClose;
  busy.current = props.busy;
  const { open } = props;

  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    panel.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !busy.current) onClose.current();
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [open]);

  if (!props.open) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-3 animate-in fade-in duration-150 sm:items-center sm:p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !props.busy) props.onClose(); }}>
      <div ref={panel} role="dialog" aria-modal="true" aria-labelledby="form-modal-title"
        className={cn('flex max-h-[calc(100vh-1.5rem)] w-full flex-col rounded-xl border border-border bg-card shadow-2xl animate-in fade-in zoom-in-95 slide-in-from-bottom-2 duration-200',
          props.wide ? 'max-w-3xl' : 'max-w-lg')}>
        <div className="flex flex-col gap-1 border-b border-border px-5 py-4">
          <span id="form-modal-title" className="text-lg font-bold tracking-tight">{props.title}</span>
          {props.description !== undefined && (
            <span className="text-[13px] leading-relaxed text-muted-foreground text-pretty">{props.description}</span>
          )}
        </div>
        <div className="flex-1 overflow-y-auto px-5 py-4">{props.children}</div>
        {props.footer !== undefined && (
          <div className="flex flex-wrap items-center gap-2.5 border-t border-border px-5 py-3.5">{props.footer}</div>
        )}
      </div>
    </div>
  );
}
