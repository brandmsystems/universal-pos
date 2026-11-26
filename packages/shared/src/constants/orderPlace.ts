/**
 * Where an order is: at tables, or numbered at the counter. A parcel is always
 * at the counter; dine-in is at the counter only where the plan has no tables
 * (Basic, 0075). The counter number is ONE sequence for both, so the prefix --
 * P for a parcel, D for dine-in -- is what tells them apart when it is called out.
 *
 * One function, because the kitchen ticket, the KDS card, the billing queue, the
 * receipt and the open-orders list all print it, and five copies of the
 * parcel/table ternary is how one of them ends up saying "Table -" for a counter
 * order nobody seated.
 */
export interface OrderPlace {
  readonly serviceType: 'dine_in' | 'parcel';
  /** The counter number; present exactly when the order is at the counter. */
  readonly parcelNo: number | null;
  readonly pickupName: string | null;
  readonly tables: readonly string[];
}

/** `P-12` / `D-4`, or null for an order seated at tables. */
export function counterNumber(place: Pick<OrderPlace, 'serviceType' | 'parcelNo'>): string | null {
  if (place.parcelNo === null) return place.serviceType === 'parcel' ? 'P-?' : null;
  return `${place.serviceType === 'parcel' ? 'P' : 'D'}-${place.parcelNo}`;
}

/** "Parcel P-12 · Rahul", "Dine-in D-4", or "T1 + T2". */
export function describePlace(place: OrderPlace, joiner = ' · '): string {
  const number = counterNumber(place);
  if (number !== null) {
    const kind = place.serviceType === 'parcel' ? 'Parcel' : 'Dine-in';
    return `${kind} ${number}${place.pickupName ? `${joiner}${place.pickupName}` : ''}`;
  }
  return place.tables.length === 0 ? 'Table' : place.tables.join(' + ');
}
