import { useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { ChefHat, ReceiptText, Store } from 'lucide-react';
import { cn } from 'cn';
import { COPY_LABEL, PAPER, pageBox, renderCopiesHtml, type CopyPage, type CopyPurpose, type PrintLayout, type RenderOptions } from './receipt.js';

/**
 * The copies as they will come out of the printer: one tab per copy, drawn by
 * the same renderer that prints, at the paper's own width and scaled to fit the
 * screen. A roll is as long as its bill; a sheet keeps its proportions.
 */

const PX_PER_MM = 96 / 25.4;

const TAB: Record<CopyPurpose, { readonly label: string; readonly icon: typeof Store }> = {
  customer: { label: 'Customer bill', icon: ReceiptText },
  kitchen: { label: 'Kitchen copy', icon: ChefHat },
  counter: { label: 'Counter copy', icon: Store },
};

export function PrintPreview(props: {
  pages: readonly CopyPage[];
  layout: PrintLayout;
  options?: RenderOptions;
  /** The widest the preview may be drawn, in px. */
  maxWidth?: number;
}): ReactElement {
  const purposes = props.pages.map((p) => p.purpose);
  const [shown, setShown] = useState<CopyPurpose>(purposes[0] ?? 'customer');
  const current = purposes.includes(shown) ? shown : purposes[0] ?? 'customer';
  const page = props.pages.filter((p) => p.purpose === current);
  const html = renderCopiesHtml(page, { ...props.options, layout: props.layout });

  const box = pageBox(props.layout);
  const roll = PAPER[props.layout.paperSize].roll;
  const width = Math.round(box.widthMm * PX_PER_MM);
  const sheetHeight = box.heightMm === null ? null : Math.round(box.heightMm * PX_PER_MM);
  const scale = Math.min(1, (props.maxWidth ?? 360) / width);

  // A roll is as long as what is on it: the frame grows to its content.
  const frame = useRef<HTMLIFrameElement>(null);
  const [contentHeight, setContentHeight] = useState(480);
  useEffect(() => {
    const element = frame.current;
    if (element === null) return undefined;
    const measure = (): void => {
      // Before the frame has loaded its page there is no document element yet:
      // nothing to measure, and the 'load' listener measures again when there is.
      const height = element.contentDocument?.documentElement?.scrollHeight;
      if (height !== undefined && height > 0) setContentHeight(height + 8);
    };
    element.addEventListener('load', measure);
    measure();
    return () => element.removeEventListener('load', measure);
  }, [html]);
  const height = roll || sheetHeight === null ? Math.max(contentHeight, 200) : sheetHeight;

  return (
    <div className="flex flex-col gap-3">
      {purposes.length > 1 && (
        <div role="tablist" aria-label="Copies" className="flex flex-wrap gap-1.5">
          {purposes.map((purpose) => {
            const Icon = TAB[purpose].icon;
            return (
              <button key={purpose} type="button" role="tab" aria-selected={current === purpose}
                onClick={() => setShown(purpose)}
                className={cn('flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs font-semibold transition-colors',
                  current === purpose ? 'border-primary bg-primary/10 text-foreground' : 'border-border bg-card text-muted-foreground hover:text-foreground')}>
                <Icon aria-hidden className="size-3.5" /> {TAB[purpose].label}
              </button>
            );
          })}
        </div>
      )}
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {COPY_LABEL[current]} · {PAPER[props.layout.paperSize].label}
        {roll ? '' : ` · ${props.layout.orientation}`}
      </span>
      <div className="overflow-hidden rounded-md border border-border bg-muted/40 p-3"
        style={{ width: Math.round(width * scale) + 26 }}>
        <div style={{ width: width * scale, height: height * scale }}>
          <iframe ref={frame} title={`${TAB[current].label} preview`} srcDoc={html}
            className="origin-top-left border-0 bg-white shadow-sm"
            style={{ width, height, transform: `scale(${scale})` }} />
        </div>
      </div>
    </div>
  );
}
