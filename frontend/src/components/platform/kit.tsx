import { useEffect, useId, useRef, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Check, Copy, Eye, EyeOff, X } from 'lucide-react';
import { cn } from 'cn';
import { PlatformApiError } from '../../services/platformApi.js';
import { stale, unknown, type Remote } from '../../lib/remote.js';
import { Card } from '@/components/ui/card.js';
import { Input } from '@/components/ui/input.js';
import { PasswordInput } from '@/components/ui/password-input.js';
import { Label } from '@/components/ui/label.js';
import { formatMinorWhole, minorFrom } from '../../lib/money.js';

/**
 * The control plane's shared pieces: a modal, a stat tile, form fields, and the
 * two translations every screen needs -- a refusal into a sentence, and minor
 * units into money. One copy each, so the Super Admin's restaurant page and the
 * Salesperson's dashboard cannot drift into two answers for the same row.
 */

/* ------------------------------------------------------------------ modal --- */

/**
 * A dialog over the page.
 *
 * Escape and the backdrop both close it, unless `busy` -- closing a form while
 * its request is in flight would leave the user not knowing whether it landed.
 * The body scrolls INSIDE the dialog, so a long form on a phone never pushes the
 * submit button off a screen the page itself cannot scroll to.
 */
export function Modal(props: {
  open: boolean;
  title: string;
  description?: string | undefined;
  onClose: () => void;
  busy?: boolean | undefined;
  wide?: boolean | undefined;
  children: ReactNode;
  footer?: ReactNode | undefined;
}): ReactElement | null {
  const titleId = useId();
  const dialog = useRef<HTMLDivElement | null>(null);
  // Held in refs so the effect below runs on OPEN only. Callers pass `onClose`
  // inline; as a dependency it would re-run every render and pull focus back
  // to the first field while someone is typing in the third.
  const latest = useRef({ busy: props.busy, onClose: props.onClose });
  latest.current = { busy: props.busy, onClose: props.onClose };
  const { open } = props;

  useEffect(() => {
    if (!open) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape' && !latest.current.busy) latest.current.onClose();
    };
    window.addEventListener('keydown', onKey);
    // Focus the first field, or the dialog itself, so a keyboard user starts
    // inside the thing that just opened rather than behind it.
    const first = dialog.current?.querySelector<HTMLElement>(
      'input:not([disabled]), select:not([disabled]), textarea:not([disabled])');
    (first ?? dialog.current)?.focus();
    return () => {
      document.body.style.overflow = previous;
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  if (!props.open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-0 sm:items-center sm:p-4"
      onMouseDown={(event) => { if (event.target === event.currentTarget && !props.busy) props.onClose(); }}>
      <div ref={dialog} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}
        className={cn(
          'flex max-h-[92vh] w-full flex-col rounded-t-xl border border-border bg-card shadow-xl outline-none sm:rounded-xl',
          props.wide ? 'sm:max-w-3xl' : 'sm:max-w-lg',
        )}>
        <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
          <div className="flex min-w-0 flex-col gap-1">
            <h2 id={titleId} className="text-base font-semibold text-foreground">{props.title}</h2>
            {props.description !== undefined && (
              <p className="text-sm leading-relaxed text-muted-foreground">{props.description}</p>
            )}
          </div>
          <button type="button" onClick={props.onClose} disabled={props.busy} aria-label="Close"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:opacity-40">
            <X className="size-4" />
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-4">{props.children}</div>
        {props.footer !== undefined && (
          <div className="flex flex-wrap justify-end gap-2 border-t border-border px-5 py-3">
            {props.footer}
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ tiles --- */

export function StatTile(props: {
  label: string; value: ReactNode; caption?: string | undefined; icon?: ReactNode | undefined; tone?: 'warn' | undefined;
}): ReactElement {
  return (
    <Card className="gap-2 p-5">
      <span className="flex items-center justify-between text-xs font-semibold uppercase tracking-wide text-subtle-foreground">
        {props.label}
        {props.icon !== undefined && <span className="text-muted-foreground">{props.icon}</span>}
      </span>
      <span className={cn('text-3xl font-bold tabular-nums',
        props.tone === 'warn' ? 'text-status-warn' : 'text-foreground')}>
        {props.value}
      </span>
      {props.caption !== undefined && (
        <span className="text-xs text-muted-foreground">{props.caption}</span>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ forms --- */

export const fieldLabel = 'text-xs font-semibold uppercase tracking-wide text-muted-foreground';

export const selectClass =
  'h-10 w-full rounded-md border border-input bg-card px-2.5 text-sm text-foreground '
  + 'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50 '
  + 'disabled:opacity-60';

export function TextField(props: {
  label: string; value: string; onChange: (value: string) => void;
  placeholder?: string | undefined; mono?: boolean | undefined; hint?: string | undefined; error?: string | null | undefined;
  type?: string | undefined; disabled?: boolean | undefined; required?: boolean | undefined;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className={fieldLabel}>
        {props.label}{props.required && <span className="text-destructive"> *</span>}
      </Label>
      {props.type === 'password' ? (
        <PasswordInput id={id} value={props.value} placeholder={props.placeholder}
          disabled={props.disabled} aria-invalid={props.error ? true : undefined}
          autoComplete="new-password"
          onChange={(event) => props.onChange(event.target.value)}
          className={cn('h-10', props.mono && 'font-mono')} />
      ) : (
        <Input id={id} value={props.value} placeholder={props.placeholder} type={props.type ?? 'text'}
          disabled={props.disabled} aria-invalid={props.error ? true : undefined}
          onChange={(event) => props.onChange(event.target.value)}
          className={cn('h-10', props.mono && 'font-mono')} />
      )}
      {props.error ? (
        <span className="text-[11px] leading-snug text-destructive">{props.error}</span>
      ) : props.hint !== undefined && (
        <span className="text-[11px] leading-snug text-subtle-foreground">{props.hint}</span>
      )}
    </div>
  );
}

export function SelectField(props: {
  label: string; value: string; onChange: (value: string) => void;
  options: readonly { value: string; label: string }[]; placeholder?: string | undefined;
  hint?: string | undefined; disabled?: boolean | undefined; required?: boolean | undefined;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className={fieldLabel}>
        {props.label}{props.required && <span className="text-destructive"> *</span>}
      </Label>
      <select id={id} value={props.value} disabled={props.disabled}
        onChange={(event) => props.onChange(event.target.value)} className={selectClass}>
        {props.placeholder !== undefined && <option value="">{props.placeholder}</option>}
        {props.options.map((option) => (
          <option key={option.value} value={option.value}>{option.label}</option>
        ))}
      </select>
      {props.hint !== undefined && (
        <span className="text-[11px] leading-snug text-subtle-foreground">{props.hint}</span>
      )}
    </div>
  );
}

export function TextArea(props: {
  label: string; value: string; onChange: (value: string) => void;
  placeholder?: string | undefined; hint?: string | undefined; required?: boolean | undefined;
}): ReactElement {
  const id = useId();
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className={fieldLabel}>
        {props.label}{props.required && <span className="text-destructive"> *</span>}
      </Label>
      <textarea id={id} value={props.value} placeholder={props.placeholder} rows={3}
        onChange={(event) => props.onChange(event.target.value)}
        className="w-full resize-y rounded-md border border-input bg-card px-2.5 py-2 text-sm text-foreground focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50" />
      {props.hint !== undefined && (
        <span className="text-[11px] leading-snug text-subtle-foreground">{props.hint}</span>
      )}
    </div>
  );
}

export function Notice(props: { tone: 'error' | 'success'; children: ReactNode }): ReactElement {
  return (
    <div role={props.tone === 'error' ? 'alert' : 'status'} className={cn(
      'rounded-lg border px-3.5 py-2.5 text-sm leading-relaxed',
      props.tone === 'error'
        ? 'border-destructive/50 bg-destructive/10 text-foreground'
        : 'border-primary/40 bg-primary/10 text-foreground',
    )}>
      {props.children}
    </div>
  );
}

/* ---------------------------------------------------------- translations --- */

/** The server's own sentence where it sent one, capitalised; otherwise what happened. */
export function refusalMessage(error: unknown, nothingHappened: string): string {
  if (error instanceof PlatformApiError) {
    if (error.failure.kind === 'refused') {
      if (error.failure.status === 403) return 'Your role is not allowed to do this.';
      return error.message.charAt(0).toUpperCase() + error.message.slice(1);
    }
    if (error.failure.kind === 'signed-out') return 'Your session ended. Sign in again.';
    return `The server could not be reached, so ${nothingHappened}.`;
  }
  return 'That did not go through.';
}

/** A failed read, kept as `stale` when offline and labelled otherwise. */
export function failedRead<T>(error: unknown, current: Remote<T>): Remote<T> {
  if (error instanceof PlatformApiError && error.failure.kind === 'offline') return stale(current);
  return unknown<T>(
    error instanceof PlatformApiError && error.failure.kind === 'refused'
      && error.failure.status === 403 ? 'not-permitted' : 'read-failed');
}

/** Minor units to a currency string, in the currency's own locale conventions. */
export function formatMoney(minor: number | null, currency: string | null): string {
  if (minor === null || currency === null) return '—';
  return formatMinorWhole(minorFrom(minor), currency);
}

export function formatDate(value: string | null): string {
  return value === null ? '—' : value.slice(0, 10);
}

/** Whole days from now to a timestamp; negative once it has passed. */
export function daysUntil(value: string | null, now: number = Date.now()): number | null {
  if (value === null) return null;
  return Math.ceil((new Date(value).getTime() - now) / 86_400_000);
}

/* ------------------------------------------------------------------ secrets --- */

/**
 * A value shown once -- a setup link, a new password -- with a copy button.
 * Nothing here stores it: close the dialog and it is gone, which is the point.
 */
export function CopyField(props: { label: string; value: string; secret?: boolean | undefined }): ReactElement {
  const [copied, setCopied] = useState(false);
  // A secret starts masked, so a password on screen is not also a password in
  // every screenshot and over every shoulder; the eye reveals it on purpose.
  const [revealed, setRevealed] = useState(!props.secret);
  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(props.value);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  }
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{props.label}</span>
      <div className="flex min-w-0 items-stretch gap-2">
        <code className="min-w-0 flex-1 break-all rounded-md border border-border bg-background px-2.5 py-2 font-mono text-xs text-foreground">
          {revealed ? props.value : '•'.repeat(Math.min(props.value.length, 16))}
        </code>
        {props.secret && (
          <button type="button" onClick={() => setRevealed((v) => !v)}
            aria-label={revealed ? `Hide ${props.label}` : `Show ${props.label}`} aria-pressed={revealed}
            className="inline-flex shrink-0 items-center rounded-md border border-input px-2.5 text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
            {revealed ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
          </button>
        )}
        <button type="button" onClick={() => { void copy(); }} aria-label={`Copy ${props.label}`}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-md border border-input px-2.5 text-xs text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
          {copied ? <Check className="size-3.5 text-primary" /> : <Copy className="size-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

/** Where a Restaurant Manager redeems a setup link. A fragment, so the token never reaches a server log. */
export function setupLink(token: string): string {
  return `${window.location.origin}/admin.html#invite=${encodeURIComponent(token)}`;
}

/** A restaurant's own address, `https://<site>/<slug>`: its page and its sign-in. */
export function restaurantUrl(slug: string): string {
  return `${window.location.origin}/${slug}`;
}
