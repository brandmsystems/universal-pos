import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { CircleCheck, Download, ShieldCheck, Smartphone } from 'lucide-react';
import { androidSteps, iphoneSteps, phoneKind } from '../../../lib/posApp.js';
import { installState, onInstallStateChange, promptInstall, type InstallState } from '../../../services/posApp.js';
import type { PublicRestaurant } from '../admin/RestaurantPage.js';
import { RestaurantMark } from './RestaurantGate.js';

/**
 * The POS opened from the manager's install link or QR code (`?install=1`):
 * how to put this restaurant's POS on the phone's Home Screen. Never shown in
 * the installed app, whose start address carries no install query. Closing it
 * leaves the POS exactly as a plain visit shows it.
 */
export function InstallHelp(props: { restaurant: PublicRestaurant; onClose: () => void }): ReactElement {
  const appName = `${props.restaurant.name} POS`;
  const kind = phoneKind(navigator.userAgent, navigator.maxTouchPoints ?? 0);
  const [state, setState] = useState<InstallState>(installState);
  const [outcome, setOutcome] = useState<'dismissed' | null>(null);
  useEffect(() => onInstallStateChange(setState), []);

  const guides = [
    { key: 'android', title: 'Android · Chrome', steps: androidSteps(appName) },
    { key: 'iphone', title: 'iPhone · Safari', steps: iphoneSteps(appName) },
  ];
  if (kind === 'iphone') guides.reverse();

  return (
    <div role="dialog" aria-modal="true" aria-labelledby="install-help-title"
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/40 p-0 sm:items-center sm:p-4">
      <div className="flex max-h-[92vh] w-full max-w-[520px] flex-col gap-5 overflow-y-auto rounded-t-3xl border border-border bg-card p-6 shadow-xl animate-in fade-in slide-in-from-bottom-2 duration-300 sm:rounded-3xl">
        <div className="flex items-center gap-3">
          <RestaurantMark restaurant={props.restaurant} />
          <div className="min-w-0">
            <h2 id="install-help-title" className="m-0 text-xl font-bold">Install {appName}</h2>
            <p className="m-0 text-sm text-muted-foreground">Opens {props.restaurant.name}&apos;s POS straight from the Home Screen.</p>
          </div>
        </div>

        {state.installed ? (
          <p role="status" className="m-0 flex items-center gap-2 rounded-xl bg-background px-4 py-3 text-sm font-semibold">
            <CircleCheck aria-hidden className="size-5 shrink-0 text-paid" />
            Installed. Open {appName} from the Home Screen.
          </p>
        ) : state.canPrompt ? (
          <button type="button"
            onClick={() => { void promptInstall().then((result) => setOutcome(result === 'dismissed' ? 'dismissed' : null)); }}
            className="flex h-14 w-full items-center justify-center gap-2 rounded-2xl bg-brand-gradient text-lg font-bold text-black shadow-sm transition-transform active:scale-[0.98]">
            <Download aria-hidden className="size-5" />
            Install app
          </button>
        ) : null}
        {outcome === 'dismissed' && !state.installed && (
          <p role="status" className="m-0 text-sm text-muted-foreground">
            Not installed. You can install it later from the browser menu, as below.
          </p>
        )}

        {guides.map((guide) => (
          <section key={guide.key} aria-label={guide.title} className="flex flex-col gap-2">
            <h3 className="m-0 flex items-center gap-2 text-sm font-semibold">
              <Smartphone aria-hidden className="size-4 text-ink-orange" />
              {guide.title}
            </h3>
            <ol className="m-0 flex list-decimal flex-col gap-1 pl-5 text-sm text-foreground">
              {guide.steps.map((step) => <li key={step}>{step}</li>)}
            </ol>
          </section>
        ))}

        <p className="m-0 flex items-start gap-2 rounded-xl bg-background px-4 py-3 text-sm">
          <ShieldCheck aria-hidden className="mt-0.5 size-5 shrink-0 text-ink-orange" />
          <span>
            The first time the app opens, the Restaurant Manager sets this phone up as a till with their username and
            password. Staff then tap their name and type their PIN.
          </span>
        </p>

        <button type="button" onClick={props.onClose}
          className="h-12 w-full rounded-2xl border border-border bg-card text-base font-semibold">
          Continue in the browser
        </button>
      </div>
    </div>
  );
}
