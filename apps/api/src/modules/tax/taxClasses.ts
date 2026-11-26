/**
 * The tax classes every restaurant starts with.
 *
 * ###########################################################################
 * WHY A DEFAULT SET EXISTS AT ALL.
 *
 * `app.menu_item.tax_class_id` is NOT NULL with a foreign key, and until
 * migration 0050 `provisionTenant` created none and no route could create one.
 * A restaurant provisioned through `POST /tenants` therefore could not add a
 * single dish: the create form asked for a tax class id, there was nothing to
 * put in it, and nothing listed the options. The demo tenant worked because
 * `seed-demo.mts` inserted a class directly with an owner connection, and the
 * whole suite passed for the same reason.
 *
 * A screen alone would have fixed the mechanism and left the experience: a new
 * owner facing an empty list, having to know that restaurant service is 5%
 * without input credit unless the place is a hotel above the room-tariff
 * threshold, in which case it is 18%. That is not a thing to make somebody
 * discover.
 *
 * SO IT IS A STARTING POINT, NOT A RULE. All three are editable and archivable
 * from the tax-rates screen, because which one applies is a fact about the
 * restaurant that this product cannot know -- and getting it wrong is a
 * question for the practitioner who files the returns, not for a default.
 * ###########################################################################
 *
 * ###########################################################################
 * THERE ARE NO COMPONENTS HERE, AND THAT IS THE POINT OF 0050.
 *
 * A class carries a RATE. Whether that rate arrives on a bill as CGST+SGST or
 * as IGST is derived per bill from the place of supply by
 * `src/modules/tax/registry.ts`. The old `app.tax_component` rows named the head as
 * free text, which is how a tenant could produce a bill that was right and a
 * return that reported zero.
 *
 * Every rate BELOW is even in basis points, because India's are. That is no
 * longer a RULE: 0052 deleted `tax_class_rate_halves`, so a tenant may enter
 * any rate their jurisdiction charges -- 7.25% included -- and the heads are
 * allocated across whatever shares the treatment defines.
 * ###########################################################################
 */
export interface DefaultTaxClass {
  readonly key: string;
  readonly name: string;
  readonly rateBps: number;
}

export const DEFAULT_TAX_CLASSES: readonly DefaultTaxClass[] = [
  // The ordinary restaurant rate. Named for what an owner recognises rather
  // than for the notification it comes from.
  { key: 'gst_5', name: 'GST 5% (restaurant)', rateBps: 500 },
  // A restaurant inside a hotel above the room-tariff threshold. Present so
  // that the owner of one does not have to work out that they need it, and
  // archivable in one click by everybody else.
  { key: 'gst_18', name: 'GST 18% (hotel restaurant)', rateBps: 1800 },
  // Exempt items. An explicit ZERO class rather than leaving the tax class
  // unset: `resolveOrderableItem` treats a null rate as "no tax class
  // configured", which is a setup gap that loses real money, and 0 as
  // "lawfully zero-rated". A report cannot tell the two apart if they share a
  // representation -- the same argument migration 0048 makes for the
  // unregistered branch.
  { key: 'gst_0', name: 'Exempt (0%)', rateBps: 0 },
];

/**
 * A UAE restaurant's starting rates (0083): the standard VAT rate and a zero
 * class, as rows the owner edits under Tax rates -- the rate is never a
 * constant in the code that charges it.
 */
const UAE_TAX_CLASSES: readonly DefaultTaxClass[] = [
  { key: 'vat_5', name: 'VAT 5% (standard)', rateBps: 500 },
  { key: 'vat_0', name: 'Zero-rated / exempt (0%)', rateBps: 0 },
];

const BY_JURISDICTION: Readonly<Record<string, readonly DefaultTaxClass[]>> = {
  IN: DEFAULT_TAX_CLASSES,
  AE: UAE_TAX_CLASSES,
};

/**
 * The rates a new restaurant starts with, by its jurisdiction. A country with
 * no set is refused, never handed India's: a GST class in another country's
 * catalogue is a bill taxed under the wrong law with nothing looking wrong.
 */
export function defaultTaxClassesFor(jurisdictionCode: string): readonly DefaultTaxClass[] {
  const found = BY_JURISDICTION[jurisdictionCode];
  if (found === undefined) throw new Error(`no starting tax classes are defined for ${jurisdictionCode}`);
  return found;
}
