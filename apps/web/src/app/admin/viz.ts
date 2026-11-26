/**
 * The chart parameters, validated rather than chosen by eye.
 *
 * ###########################################################################
 * THESE SIX HUES WERE RUN THROUGH THE CHECKER, IN THIS ORDER, ON THIS SURFACE.
 *
 *   node scripts/validate_palette.js "#2a78d6,#eb6834,#1baf7a,#eda100,\
 *     #e87ba4,#008300" --mode light --surface "#FFFFFF"
 *
 *   lightness band          PASS   all six inside L 0.43-0.77
 *   chroma floor            PASS   all six >= 0.1
 *   CVD separation          PASS   worst adjacent 9.1 protan (tritan 5.8)
 *   normal-vision floor     PASS   worst adjacent 19.6
 *   contrast vs surface     WARN   aqua 2.82, yellow 2.17, magenta 2.69
 *
 * The ORDER is the colourblind-safety mechanism, not decoration: the slots are
 * assigned 1..n in sequence and never cycled. Reordering them invalidates the
 * adjacent-pair result above.
 *
 * Two obligations come out of that run and are honoured in Dashboard.tsx:
 *
 *   - The contrast WARN and the tritan 5.8 both require SECONDARY ENCODING, so
 *     the payment split ships a labelled list beside the bar (name, amount and
 *     share for every segment) and a 2px surface gap between segments. Identity
 *     is never carried by hue alone.
 *   - Text never wears a series colour. A swatch beside the label carries it.
 * ###########################################################################
 */
export const series: readonly string[] = [
  '#2a78d6', // 1 blue
  '#eb6834', // 2 orange
  '#1baf7a', // 3 aqua
  '#eda100', // 4 yellow
  '#e87ba4', // 5 magenta
  '#008300', // 6 green
];

/** One hue for magnitude, which is what a single-series bar chart is. */
export const magnitude = '#2a78d6';

/**
 * Fixed, never themed, and never reused as a series colour. Each ships with a
 * WORD as well as a colour -- on this light surface `warning` sits at 1.79:1
 * and `serious` at 2.57:1, so neither can carry meaning alone.
 */
export const status = {
  good: '#0ca30c',
  warning: '#fab219',
  serious: '#ec835a',
  critical: '#d03b3b',
} as const;

/** Hairline, solid, one step off the surface. Never dashed. */
export const gridline = '#E2E2E2';
