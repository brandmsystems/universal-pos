import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Check, Copy, ExternalLink, Info, ShieldCheck, Smartphone, TriangleAlert } from 'lucide-react';
import type { Api } from '../../../services/api.js';
import { androidSteps, iphoneSteps, posInstallUrl } from '../../../lib/posApp.js';
import { buttonVariants } from '@/components/ui/button.js';
import { Card } from '@/components/ui/card.js';
import { cn } from '@/lib/utils.js';

/**
 * Install POS App, on the manager's dashboard: the link and QR code that put
 * this restaurant's POS on a phone's Home Screen, and how many of the plan's
 * tills are set up. Installing grants nothing: an installed app opens
 * `/{slug}/pos`, and the till set-up there is the same one, with the same
 * limit, as in a browser.
 */

/** The QR code's dark modules as one SVG path, one unit per module, inside a 4-module quiet zone. */
export function qrPath(size: number, isDark: (row: number, column: number) => boolean): string {
  let path = '';
  for (let row = 0; row < size; row += 1) {
    for (let column = 0; column < size; column += 1) {
      if (isDark(row, column)) path += `M${column + 4} ${row + 4}h1v1h-1z`;
    }
  }
  return path;
}

type Qr = { readonly size: number; readonly path: string } | null;

function useQr(text: string): Qr {
  const [qr, setQr] = useState<Qr>(null);
  useEffect(() => {
    let live = true;
    // Loaded with the card only, and drawn on this device: the link is never sent anywhere to be encoded.
    void import('qrcode').then((lib) => {
      // A CommonJS package: its functions are named exports or on `default`, by bundler.
      const create = typeof lib.create === 'function' ? lib.create : lib.default.create;
      const { modules } = create(text, { errorCorrectionLevel: 'M' });
      if (live) setQr({ size: modules.size, path: qrPath(modules.size, (r, c) => modules.get(r, c) === 1) });
    }).catch(() => { if (live) setQr(null); });
    return () => { live = false; };
  }, [text]);
  return qr;
}

interface Tills { readonly used: number; readonly limit: number }

/** The plan's till limit and how many are set up: the same count the server refuses a third one by. */
function useTills(api: Api): Tills | null {
  const [tills, setTills] = useState<Tills | null>(null);
  useEffect(() => {
    let live = true;
    api.get<{ entitlements: { devices: number }; usage?: { devices?: number } }>('/admin/entitlements')
      .then((read) => {
        const used = read.usage?.devices;
        if (live && typeof used === 'number') setTills({ used, limit: read.entitlements.devices });
      })
      .catch(() => { if (live) setTills(null); });
    return () => { live = false; };
  }, [api]);
  return tills;
}

export function InstallPosApp(props: {
  api: Api; slug: string; restaurantName: string; logoUrl: string | null; origin?: string;
}): ReactElement {
  const appName = `${props.restaurantName} POS`;
  const link = posInstallUrl(props.origin ?? window.location.origin, props.slug);
  const qr = useQr(link);
  const tills = useTills(props.api);
  const [copied, setCopied] = useState(false);
  const full = tills !== null && tills.used >= tills.limit;

  const copy = (): void => {
    void navigator.clipboard?.writeText(link).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    });
  };

  return (
    <Card aria-labelledby="install-pos-app" className="mb-6 gap-0 overflow-hidden border-border p-0">
      <div className="grid gap-6 p-5 sm:p-6 lg:grid-cols-[auto_minmax(0,1fr)_auto] lg:items-center">
        {/* What the phone will show: the app on a Home Screen. */}
        <div aria-hidden className="mx-auto flex h-[196px] w-[108px] flex-col items-center rounded-[26px] border-[5px] border-foreground bg-[linear-gradient(180deg,#FFF1E6,#F7F7F7)] px-2 pt-3">
          <span className="mb-5 h-1.5 w-8 rounded-full bg-foreground/80" />
          <span className="flex size-14 items-center justify-center overflow-hidden rounded-2xl bg-white shadow-md">
            <img src={props.logoUrl ?? '/app-icons/pos-icon-192.png'} alt="" className="size-full object-contain" />
          </span>
          <span className="mt-1.5 w-full truncate text-center text-[10px] font-semibold">{appName}</span>
        </div>

        <div className="flex min-w-0 flex-col gap-3">
          <div className="flex items-center gap-3">
            {props.logoUrl !== null && <img src={props.logoUrl} alt="" className="size-10 shrink-0 rounded-lg object-contain" />}
            <div className="min-w-0">
              <h2 id="install-pos-app" className="m-0 flex items-center gap-2 text-lg font-bold">
                <Smartphone aria-hidden className="size-5 text-ink-orange" />
                Install POS App
              </h2>
              <p className="m-0 truncate text-sm text-muted-foreground">{props.restaurantName}</p>
            </div>
          </div>
          <p className="m-0 text-sm text-muted-foreground">
            Put {appName} on a phone&apos;s Home Screen. The icon opens this restaurant&apos;s POS, full screen,
            with no address bar. Scan the QR code with the phone, or open the link on it.
          </p>
          <div className="flex flex-wrap gap-2">
            <a href={link} target="_blank" rel="noopener" className={cn(buttonVariants(), 'gap-2')}>
              <ExternalLink aria-hidden className="size-4" />
              Install POS App
            </a>
            <button type="button" onClick={copy} className={cn(buttonVariants({ variant: 'outline' }), 'gap-2')}>
              {copied ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
              {copied ? 'Link copied' : 'Copy link'}
            </button>
          </div>
          <code className="block truncate text-xs text-muted-foreground">{link}</code>

          {tills !== null && (
            <p role="status" className={cn('m-0 flex items-start gap-2 rounded-lg px-3 py-2 text-sm',
              full ? 'bg-accent text-foreground' : 'bg-muted text-foreground')}>
              {full
                ? <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-orange" />
                : <Info aria-hidden className="mt-0.5 size-4 shrink-0" />}
              <span>
                <strong>Tills set up: {tills.used} of {tills.limit}.</strong>{' '}
                {full
                  ? 'Another phone can install the app, but it cannot be set up as a till until one is taken out of use under Tablets.'
                  : `${tills.limit - tills.used} more phone or computer can be set up as a till.`}
              </span>
            </p>
          )}
        </div>

        <figure className="m-0 flex flex-col items-center gap-2">
          {qr === null ? (
            <div className="size-[168px] animate-pulse rounded-xl bg-muted" aria-label="Making the QR code" />
          ) : (
            <svg role="img" aria-label={`QR code: ${link}`} viewBox={`0 0 ${qr.size + 8} ${qr.size + 8}`}
              className="size-[168px] rounded-xl border border-border bg-white" shapeRendering="crispEdges">
              <path d={qr.path} fill="#111111" />
            </svg>
          )}
          <figcaption className="text-xs text-muted-foreground">Scan with the phone&apos;s camera</figcaption>
        </figure>
      </div>

      <div className="grid gap-5 border-t border-border bg-muted/40 p-5 sm:p-6 md:grid-cols-2">
        {[
          { key: 'android', title: 'Android · Chrome', steps: androidSteps(appName) },
          { key: 'iphone', title: 'iPhone · Safari', steps: iphoneSteps(appName) },
        ].map((guide) => (
          <section key={guide.key} aria-label={guide.title} className="flex flex-col gap-2">
            <h3 className="m-0 flex items-center gap-2 text-sm font-semibold">
              <Smartphone aria-hidden className="size-4 text-ink-orange" />
              {guide.title}
            </h3>
            <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-sm">
              {guide.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
          </section>
        ))}
        <p className="m-0 flex items-start gap-2 text-sm md:col-span-2">
          <ShieldCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-ink-orange" />
          <span>
            <strong>More than one phone:</strong> install the app on each phone the same way; every icon opens{' '}
            {props.restaurantName}&apos;s POS. The first time it opens, you set that phone up as a till with your
            username and password{tills !== null ? `, up to ${tills.limit} tills` : ''}. Staff then sign in on a till
            by tapping their name and typing their PIN.
          </span>
        </p>
      </div>
    </Card>
  );
}
