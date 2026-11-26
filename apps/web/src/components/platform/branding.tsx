import { useId, useRef } from 'react';
import type { ReactElement } from 'react';
import {
  LOGO_MAX_BYTES, LOGO_TYPES, normaliseThemeColor, readableOn,
} from '@universalpos/shared';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { cn } from 'cn';

const fieldLabel = 'text-xs font-semibold uppercase tracking-wide text-muted-foreground';

/** A picked logo, ready to send: the server re-checks type, bytes and size. */
export interface LogoChoice {
  readonly contentType: string;
  readonly dataBase64: string;
  readonly previewUrl: string;
}

export async function readLogo(file: File): Promise<LogoChoice | string> {
  if (!(LOGO_TYPES as readonly string[]).includes(file.type)) return 'Choose a PNG, JPEG or WebP image.';
  if (file.size > LOGO_MAX_BYTES) return `The logo must be at most ${LOGO_MAX_BYTES / 1024} KB.`;
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return { contentType: file.type, dataBase64: btoa(binary), previewUrl: URL.createObjectURL(file) };
}

export function ThemeColorField(props: {
  value: string;
  onChange: (value: string) => void;
  /** "Primary colour" / "Secondary colour"; the one colour field serves both. */
  label?: string;
  /** What this colour is used for, shown under a valid value. */
  usage?: string;
}): ReactElement {
  const id = useId();
  const label = props.label ?? 'Theme colour';
  const colour = props.value === '' ? null : normaliseThemeColor(props.value);
  const invalid = props.value !== '' && colour === null;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label htmlFor={id} className={fieldLabel}>{label}</Label>
      <div className="flex items-center gap-2">
        <input type="color" aria-label={`Pick the ${label.toLowerCase()}`} value={colour ?? '#fa5c00'}
          onChange={(event) => props.onChange(event.target.value)}
          className="h-10 w-12 cursor-pointer rounded-md border border-input bg-card p-1" />
        <Input id={id} value={props.value} placeholder="#fa5c00"
          aria-invalid={invalid ? true : undefined}
          onChange={(event) => props.onChange(event.target.value)} className="h-10 font-mono" />
        {props.value !== '' && (
          <Button type="button" variant="ghost" size="sm" onClick={() => props.onChange('')}>Clear</Button>
        )}
      </div>
      {invalid ? (
        <span className="text-[11px] text-destructive">A hex colour like #fa5c00.</span>
      ) : colour !== null ? (
        <span className="w-fit rounded px-2 py-0.5 text-[11px] font-semibold"
          style={{ background: colour, color: readableOn(colour) }}>
          {props.usage ?? 'Buttons and highlights in the restaurant’s screens'}
        </span>
      ) : (
        <span className="text-[11px] text-subtle-foreground">Optional. Blank keeps the standard colours.</span>
      )}
    </div>
  );
}

/** A tint of a colour toward white: the light surfaces of a brand. */
const tint = (colour: string, percent: number): string => `color-mix(in srgb, ${colour} ${percent}%, white)`;

/**
 * The restaurant's look as its staff will see it: the staff login (logo, name,
 * a staff card, the PIN and the Sign in button) and a POS button, drawn from the
 * colours being edited -- before anything is saved. The primary colour is the
 * buttons and filled marks; the secondary, when set, is the tinted surfaces
 * (otherwise a tint of the primary), exactly as `applyThemeColor` applies them.
 */
export function BrandPreview(props: {
  name: string;
  logoUrl: string | null;
  primary: string;
  secondary: string;
}): ReactElement {
  const primary = normaliseThemeColor(props.primary) ?? '#fa5c00';
  const secondary = normaliseThemeColor(props.secondary);
  const surface = secondary !== null ? tint(secondary, 22) : tint(primary, 10);
  const ink = `color-mix(in srgb, ${primary} 75%, black)`;
  const onPrimary = readableOn(primary);
  const name = props.name.trim() === '' ? 'Your restaurant' : props.name.trim();
  return (
    <div className="flex min-w-0 flex-col gap-1.5" aria-label="Brand preview">
      <span className={fieldLabel}>Preview</span>
      <div className="overflow-hidden rounded-xl border border-input bg-white text-[#111]"
        style={{ backgroundImage: `radial-gradient(ellipse at top, ${surface}, transparent 70%)` }}>
        <div className="flex items-center gap-2.5 px-4 pt-3.5">
          {props.logoUrl !== null
            ? <img src={props.logoUrl} alt="" className="size-9 rounded-md bg-white object-contain" />
            : <span className="flex size-9 items-center justify-center rounded-md text-sm font-bold" style={{ background: primary, color: onPrimary }}>{name.charAt(0).toUpperCase()}</span>}
          <div className="flex min-w-0 flex-col leading-tight">
            <span className="truncate text-sm font-bold">{name}</span>
            <span className="text-[10px] font-bold uppercase tracking-[0.12em]" style={{ color: ink }}>Staff login</span>
          </div>
        </div>
        <div className="m-3.5 overflow-hidden rounded-xl border border-black/10 bg-white shadow-sm">
          <div className="flex flex-col items-center gap-1 py-3" style={{ background: surface }}>
            <span className="flex size-10 items-center justify-center rounded-full text-sm font-bold ring-4 ring-white"
              style={{ background: primary, color: onPrimary }}>A</span>
            <span className="text-xs font-bold">Asha</span>
          </div>
          <div className="flex flex-col gap-2 p-3">
            <div className="flex justify-center gap-1.5">
              {[0, 1, 2, 3].map((i) => (
                <span key={i} className="size-5 rounded-md" style={i < 2 ? { background: primary } : { boxShadow: 'inset 0 0 0 1px #ddd' }} />
              ))}
            </div>
            <span className="flex h-7 items-center justify-center rounded-lg text-[11px] font-bold" style={{ background: primary, color: onPrimary }}>
              Sign in
            </span>
            <div className="flex gap-1.5">
              <span className="flex h-6 grow items-center justify-center rounded-md text-[10px] font-semibold" style={{ background: surface, color: ink }}>Orders</span>
              <span className="flex h-6 grow items-center justify-center rounded-md text-[10px] font-semibold" style={{ background: primary, color: onPrimary }}>New order</span>
            </div>
          </div>
        </div>
      </div>
      <span className="text-[11px] text-subtle-foreground">How the staff login and POS look with these colours. Saved, it applies to this restaurant only.</span>
    </div>
  );
}

export function LogoField(props: {
  /** The logo already saved, as a URL, or null. */
  current: string | null;
  choice: LogoChoice | null;
  removed: boolean;
  error: string | null;
  onChoose: (file: File) => void;
  onRemove: () => void;
  onUndo: () => void;
}): ReactElement {
  const input = useRef<HTMLInputElement>(null);
  const shown = props.choice?.previewUrl ?? (props.removed ? null : props.current);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className={fieldLabel}>Logo</span>
      <div className="flex items-center gap-3">
        <div className={cn(
          'flex size-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-input bg-card',
          shown === null && 'border-dashed',
        )}>
          {shown === null
            ? <span className="text-[10px] text-subtle-foreground">No logo</span>
            : <img src={shown} alt="Restaurant logo" className="size-full object-contain" />}
        </div>
        <div className="flex flex-wrap gap-2">
          <input ref={input} type="file" accept={LOGO_TYPES.join(',')} className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) props.onChoose(file);
              event.target.value = '';
            }} />
          <Button type="button" variant="outline" size="sm" onClick={() => input.current?.click()}>
            {shown === null ? 'Upload logo' : 'Replace'}
          </Button>
          {shown !== null && (
            <Button type="button" variant="ghost" size="sm" onClick={props.onRemove}>Remove</Button>
          )}
          {(props.choice !== null || props.removed) && props.current !== null && (
            <Button type="button" variant="ghost" size="sm" onClick={props.onUndo}>Undo</Button>
          )}
        </div>
      </div>
      {props.error !== null ? (
        <span className="text-[11px] text-destructive">{props.error}</span>
      ) : (
        <span className="text-[11px] text-subtle-foreground">
          PNG, JPEG or WebP, up to {LOGO_MAX_BYTES / 1024} KB. Optional.
        </span>
      )}
    </div>
  );
}
