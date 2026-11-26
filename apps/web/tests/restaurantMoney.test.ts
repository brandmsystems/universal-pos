import { afterEach, describe, expect, it } from 'vitest';
import {
  currencySymbol, formatMinor, formatMinorRounded, minorFrom, setRestaurantMoney, unitsFromMinor,
} from '../src/lib/money.js';

/**
 * Every restaurant screen formats money in the currency the restaurant bills
 * in, set once from the public lookup (0084) -- and the till's whole-unit
 * headline is only drawn where bills are paid to the whole unit.
 */
afterEach(() => setRestaurantMoney({ currency: 'INR', wholeUnitHeadlines: true }));

describe('the restaurant\'s currency', () => {
  it('is INR, grouped the Indian way, until a restaurant says otherwise', () => {
    expect(formatMinor(minorFrom(12345678))).toBe('₹1,23,456.78');
    expect(formatMinorRounded(minorFrom(29295))).toBe('₹293');
    expect(currencySymbol()).toBe('₹');
  });

  it('follows a UAE restaurant: AED, grouped in thousands, headlines to the fils', () => {
    setRestaurantMoney({ currency: 'AED', wholeUnitHeadlines: false });
    expect(formatMinor(minorFrom(12345678))).toMatch(/^AED\s?123,456\.78$/);
    // A UAE bill is paid to the fils: AED 5.25 is never headlined as AED 5.
    expect(formatMinorRounded(minorFrom(525))).toMatch(/^AED\s?5\.25$/);
    expect(unitsFromMinor(minorFrom(525))).toBe(5.25);
    expect(currencySymbol()).toBe('AED');
  });

  it('still formats another currency when one is named (a plan price on the console)', () => {
    setRestaurantMoney({ currency: 'AED', wholeUnitHeadlines: false });
    expect(formatMinor(minorFrom(99900), 'INR')).toBe('₹999.00');
  });
});
