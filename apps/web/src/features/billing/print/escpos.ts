import type { PrintLine } from './receipt.js';

/**
 * ESC/POS bytes for one copy, from the lines `copyLines` lays out. Only the
 * commands every ESC/POS receipt printer takes: initialise, code page, align,
 * bold, double height, line feed, and a cut only when this till says the
 * printer has a cutter -- a printer without one may print the cut bytes as
 * garbage or ignore them, and which it does is not something to guess.
 */

const ESC = 0x1b;
const GS = 0x1d;
const LF = 0x0a;

/** Code page 437, bytes 0x80-0xFF: the page every ESC/POS printer starts on. */
const CP437_HIGH =
  'ÇüéâäàåçêëèïîìÄÅÉæÆôöòûùÿÖÜ¢£¥₧ƒáíóúñÑªº¿⌐¬½¼¡«»░▒▓│┤╡╢╖╕╣║╗╝╜╛┐└┴┬├─┼╞╟╚╔╩╦╠═╬╧╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀αßΓπΣσµτΦΘΩδ∞φε∩≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ';

const CP437 = new Map<string, number>([...CP437_HIGH].map((ch, i) => [ch, 0x80 + i]));

/** What a few common characters outside the code page print as instead. */
const NEAREST: Record<string, string> = {
  '₹': 'Rs', '–': '-', '—': '-', '‘': "'", '’': "'", '“': '"', '”': '"', '…': '...', '×': 'x', '•': '*',
};

/**
 * Text to code page 437. ASCII as it is; an accented letter the page lacks
 * loses its accent; anything else -- Arabic, Devanagari -- prints as '?',
 * because a receipt printer in text mode has no glyph for it.
 */
export function encodeText(text: string): number[] {
  const out: number[] = [];
  for (const ch of text) {
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code < 0x7f) { out.push(code); continue; }
    const high = CP437.get(ch);
    if (high !== undefined) { out.push(high); continue; }
    const near = NEAREST[ch] ?? ch.normalize('NFD').replace(/[̀-ͯ]/g, '');
    if (near !== ch && near !== '') { out.push(...encodeText(near)); continue; }
    out.push(0x3f);
  }
  return out;
}

export function escPosCopy(lines: readonly PrintLine[], options: { readonly cut: boolean }): Uint8Array {
  const bytes: number[] = [ESC, 0x40, ESC, 0x74, 0x00];
  for (const line of lines) {
    bytes.push(ESC, 0x61, line.centre ? 1 : 0, ESC, 0x45, line.bold ? 1 : 0, GS, 0x21, line.tall ? 0x01 : 0x00);
    bytes.push(...encodeText(line.text), LF);
  }
  bytes.push(ESC, 0x61, 0, ESC, 0x45, 0, GS, 0x21, 0);
  // Feed the last line past the tear bar; with a cutter, feed to it and cut (partial).
  bytes.push(...(options.cut ? [GS, 0x56, 0x42, 0x03] : [ESC, 0x64, 0x05]));
  return Uint8Array.from(bytes);
}
