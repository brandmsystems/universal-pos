import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { PlatformApi } from '../../../services/platformApi.js';
import { Button } from '@/components/ui/button.js';
import { Notice, SelectField, refusalMessage } from '../../../components/platform/kit.js';
import type { CountrySettings } from '../../../types/restaurant.js';

/**
 * The Super Admin's country settings (0084): which countries a restaurant may
 * be created in or moved to, which one the create form starts on, and whether
 * a Sales person may move a restaurant they sold. What each country MEANS --
 * its currency, tax accounts and rounding -- is the product's, not a setting;
 * each restaurant's own tax rates are edited by its manager under Tax rates.
 * Every save is a platform audit row.
 */
export function Countries(props: { api: PlatformApi }): ReactElement {
  const [settings, setSettings] = useState<CountrySettings | null>(null);
  const [offered, setOffered] = useState<readonly string[]>([]);
  const [defaultCountry, setDefaultCountry] = useState('');
  const [salesMay, setSalesMay] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'success'; text: string } | null>(null);

  const load = (read: CountrySettings): void => {
    setSettings(read);
    setOffered(read.countries.filter((c) => c.offered).map((c) => c.code));
    setDefaultCountry(read.defaultCountry);
    setSalesMay(read.salesMayChangeCountry);
  };

  useEffect(() => {
    props.api.get<CountrySettings>('/countries').then(load)
      .catch((error: unknown) => setMessage({ tone: 'error', text: refusalMessage(error, 'the settings could not be read') }));
  }, [props.api]);

  const toggle = (code: string): void =>
    setOffered((now) => (now.includes(code) ? now.filter((c) => c !== code) : [...now, code]));

  const problem = offered.length === 0 ? 'Offer at least one country.'
    : !offered.includes(defaultCountry) ? 'The default country must be one of the offered countries.' : null;

  async function save(): Promise<void> {
    if (problem !== null) return;
    setBusy(true); setMessage(null);
    try {
      load(await props.api.patch<CountrySettings>('/settings/countries',
        { offered, defaultCountry, salesMayChangeCountry: salesMay }));
      setMessage({ tone: 'success', text: 'Saved. New restaurants see these countries from now on.' });
    } catch (error) {
      setMessage({ tone: 'error', text: refusalMessage(error, 'nothing was saved') });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {message !== null && <Notice tone={message.tone}>{message.text}</Notice>}
      <section className="flex flex-col gap-2 rounded-lg border border-border bg-card p-4">
        <span className="text-sm font-semibold">Countries offered</span>
        <span className="text-xs text-muted-foreground">
          A restaurant can be created in, or moved to, these. Withdrawing one moves no restaurant already there.
        </span>
        {(settings?.countries ?? []).map((c) => (
          <label key={c.code} className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={offered.includes(c.code)} onChange={() => toggle(c.code)} />
            <span className="font-medium">{c.name}</span>
            <span className="text-muted-foreground">· {c.currency} · {c.timezone}</span>
            {!c.billable && <span className="text-xs text-destructive">tax rules not built: cannot bill yet</span>}
          </label>
        ))}
      </section>
      <section className="flex flex-col gap-3 rounded-lg border border-border bg-card p-4">
        <SelectField label="Default country" value={defaultCountry} onChange={setDefaultCountry} required
          hint="Where the New restaurant form starts. Its currency and timezone follow; both stay changeable."
          options={(settings?.countries ?? []).filter((c) => offered.includes(c.code))
            .map((c) => ({ value: c.code, label: `${c.name} (${c.currency})` }))} />
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={salesMay} onChange={(e) => setSalesMay(e.target.checked)} />
          <span>
            Sales may change the country and currency of restaurants they sold
            <span className="block text-xs text-muted-foreground">Only ever before a restaurant&apos;s first bill.</span>
          </span>
        </label>
      </section>
      {problem !== null && <p className="text-sm text-destructive">{problem}</p>}
      <div>
        <Button type="button" onClick={() => { void save(); }} disabled={busy || settings === null || problem !== null}>
          {busy ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </div>
  );
}
