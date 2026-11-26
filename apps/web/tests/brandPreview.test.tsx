import { afterEach, describe, expect, it } from 'vitest';
import { act, useState } from 'react';
import type { ReactElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { BrandPreview, ThemeColorField } from '../src/components/platform/branding.js';

/**
 * The restaurant's branding in the create and edit forms: a primary and a
 * secondary colour, each a picker plus a HEX box, and a live preview of the
 * staff login drawn from the colours as they are typed -- before anything is
 * saved, and with nothing restaurant-specific built in.
 */

let root: Root | null = null;
let host: HTMLElement;
afterEach(() => {
  act(() => root?.unmount());
  root = null;
  host?.remove();
});

function Form(): ReactElement {
  const [primary, setPrimary] = useState('');
  const [secondary, setSecondary] = useState('');
  return (
    <>
      <BrandPreview name="Green Bowl" logoUrl={null} primary={primary} secondary={secondary} />
      <ThemeColorField label="Primary colour" value={primary} onChange={setPrimary} usage="Buttons" />
      <ThemeColorField label="Secondary colour" value={secondary} onChange={setSecondary} usage="Bands" />
    </>
  );
}

const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
async function type(input: HTMLInputElement, value: string): Promise<void> {
  await act(async () => { setter.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
}

describe('brand colours and the live preview', () => {
  it('two labelled fields, each a picker and a HEX box; the preview follows what is typed', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<Form />); });
    expect(host.querySelector('input[type="color"][aria-label="Pick the primary colour"]')).not.toBeNull();
    expect(host.querySelector('input[type="color"][aria-label="Pick the secondary colour"]')).not.toBeNull();
    const hex = [...host.querySelectorAll<HTMLInputElement>('input:not([type="color"])')];
    expect(hex).toHaveLength(2);

    const preview = host.querySelector('[aria-label="Brand preview"]')!;
    expect(preview.textContent).toContain('Green Bowl');
    const signIn = (): HTMLElement => [...preview.querySelectorAll<HTMLElement>('span')].find((s) => s.textContent === 'Sign in')!;

    await type(hex[0]!, '#1B7F3A');
    expect(signIn().style.background).toBe('rgb(27, 127, 58)');
    // White reads better on that green, and the preview picks it.
    expect(signIn().style.color).toMatch(/255, 255, 255|#fff/i);
    expect(host.textContent).toContain('Buttons');

    await type(hex[1]!, '#f59e0b');
    // jsdom drops color-mix(), so the preview's tint cannot be read here; the
    // field's own swatch shows the colour the preview is tinted from.
    const bands = [...host.querySelectorAll<HTMLElement>('span')].find((s) => s.textContent === 'Bands')!;
    expect(bands.style.background).toBe('rgb(245, 158, 11)');
    expect(signIn().style.background).toBe('rgb(27, 127, 58)');

    await type(hex[1]!, 'nope');
    expect(host.textContent).toContain('A hex colour like #fa5c00.');
  });

  it('shows the logo when there is one, and the initial when there is not', async () => {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    await act(async () => { root!.render(<BrandPreview name="Soofi" logoUrl="/logo.png" primary="#e4002b" secondary="" />); });
    expect(host.querySelector('img')?.getAttribute('src')).toBe('/logo.png');
    await act(async () => { root!.render(<BrandPreview name="Soofi" logoUrl={null} primary="#e4002b" secondary="" />); });
    expect(host.querySelector('img')).toBeNull();
    expect(host.textContent).toContain('S');
  });
});
