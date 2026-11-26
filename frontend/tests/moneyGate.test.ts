import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * FRONTEND.md §3: one money primitive, and "/ 100 appears in exactly one file".
 * This is the gate that rule always claimed and never had.
 *
 * Two lexical rules over every source file except `lib/money.ts`:
 *
 *   1. No `/ 100`, `* 100` or `100 *`. Converting between rupees and paise is
 *      the money module's job; a second copy is a second set of rounding rules.
 *   2. No arithmetic on a `minorFrom(...)` result. Summing prices on the client
 *      is how a screen shows a total that disagrees with the printed bill.
 *
 * Two shapes are NOT money and are recognised line by line, never by file --
 * a file-wide exemption would hide the next real violation in that file:
 *   - a CSS percentage (`* 100}%`, `* 100)}%`): chart geometry;
 *   - a line about basis points (it says `bps`): a tax rate, not an amount.
 * Comment lines are skipped, so prose may still talk about `/ 100`.
 */

const SRC = path.resolve(import.meta.dirname, '../src');
const MONEY_MODULE = 'lib/money.ts';

export function moneyViolations(file: string, source: string): string[] {
  if (file === MONEY_MODULE) return [];
  const found: string[] = [];
  // Block comments blanked, newlines kept, so line numbers still point at the source.
  const uncommented = source.replace(/\/\*[\s\S]*?\*\//g, (comment) => comment.replace(/[^\n]/g, ' '));
  uncommented.split('\n').forEach((line, index) => {
    const code = line.trim();
    if (code.startsWith('//') || code.startsWith('*') || code.startsWith('/*')) return;
    const at = `${file}:${index + 1}`;
    const hundred = /(\/|\*)\s*100\b|\b100\s*\*/.test(code);
    const percent = /\*\s*100\s*\)?\s*\}%/.test(code);
    const basisPoints = /bps/i.test(code);
    if (hundred && !percent && !basisPoints) found.push(`${at} converts rupees and paise outside the money module`);
    if (/minorFrom\([^)]*\)\s*[-+*/%]|[-+*/%]\s*minorFrom\(/.test(code)) found.push(`${at} does arithmetic on money`);
  });
  return found;
}

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return sources(full);
    return /\.(ts|tsx)$/.test(name) ? [full] : [];
  });
}

describe('money arithmetic lives in one module', () => {
  it('fires on each rule, and not on the shapes that are not money', () => {
    // Built to violate: a component that multiplies a Minor and one that divides by 100.
    expect(moneyViolations('x.tsx', 'const t = minorFrom(line.price) * line.quantity;')).toHaveLength(1);
    expect(moneyViolations('x.tsx', 'const total = sum + minorFrom(a);')).toHaveLength(1);
    expect(moneyViolations('x.tsx', 'return (minor / 100).toFixed(2);')).toHaveLength(1);
    expect(moneyViolations('x.tsx', 'const paise = Math.round(Number(rupees) * 100);')).toHaveLength(1);
    expect(moneyViolations('x.tsx', 'const paise = 100 * whole;')).toHaveLength(1);
    // Not money, recognised on the line itself.
    expect(moneyViolations('x.tsx', 'style={{ width: `${(row.netMinor / max) * 100}%` }}')).toEqual([]);
    expect(moneyViolations('x.tsx', '{Math.round((row.collectedMinor / total) * 100)}%')).toEqual([]);
    expect(moneyViolations('x.tsx', 'const pct = (bps / 100).toFixed(2);')).toEqual([]);
    expect(moneyViolations('x.tsx', ' * a comment may say / 100')).toEqual([]);
    expect(moneyViolations('x.tsx', '{/*\n  a JSX comment: `250.55 * 100` is not 25055\n*/}')).toEqual([]);
    expect(moneyViolations('x.tsx', '/* fine */ const t = minor / 100;')).toHaveLength(1);
    expect(moneyViolations(MONEY_MODULE, 'return (amount / 100).toFixed(2);')).toEqual([]);
  });

  it('holds over every source file in the web app', () => {
    const files = sources(SRC).map((full) => path.relative(SRC, full).split(path.sep).join('/'));
    // The set it checked: a floor, and files that must be in it.
    // 100 -> 90 with Basic-only (0077): the floor, order pane, parcel list and
    // KOT board were deleted, not moved. A ratchet only lowers for a deletion.
    expect(files.length).toBeGreaterThan(90);
    for (const required of ['lib/money.ts', 'features/billing/billing/Desk.tsx',
      'features/billing/billing/PaymentPanel.tsx', 'components/platform/kit.tsx', 'features/billing/platform/Plans.tsx']) {
      expect(files, required).toContain(required);
    }
    const violations = files.flatMap((file) => moneyViolations(file, readFileSync(path.join(SRC, file), 'utf8')));
    expect(violations).toEqual([]);
  });
});
