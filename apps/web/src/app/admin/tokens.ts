/**
 * Admin tokens: the POS palette at desk sizes.
 *
 * A manager is at a desk or on a laptop, not standing up in a rush, so the two
 * constraints that shaped the POS and the KDS both relax — and one new one
 * appears. The POS is used by someone who knows the one thing they came to do;
 * admin is used by someone changing settings they may not fully understand, and
 * whose mistakes are quiet. Prices, tax classes and revocations do not announce
 * themselves.
 *
 * So: normal reading sizes, ordinary hit targets, and weight spent on making a
 * destructive action look different from a benign one rather than on making
 * anything easy to hit.
 */
export const a = {
  surface: '#F7F7F7',
  card: '#FFFFFF',
  hairline: '#E2E2E2',
  ink: '#111111',
  inkStrong: '#000000',
  inkMuted: '#6B6B6B',
  inkSoft: '#4A4A4A',
  inkOrange: '#B84300',
  brandGradient: 'linear-gradient(180deg, #F9A008, #FA5C00)',
  /** Reserved for archive, revoke and delete. Never a heading, never a border. */
  stop: '#C1121F',
  radius: 4,
  fontUi: "Archivo, 'Helvetica Neue', Arial, sans-serif",
  fontMono: "'IBM Plex Mono', ui-monospace, monospace",
} as const;

/**
 * Column labels.
 *
 * The server sends column NAMES, because it returns a declared allowlist and
 * inventing display strings on the server would put copy in the API. This is the
 * one place that maps them, and anything unmapped falls back to the name with
 * underscores replaced — visible and ugly rather than absent, so a new column
 * shows up asking to be named.
 */
const LABELS: Readonly<Record<string, string>> = {
  id: 'ID',
  code: 'Code',
  name: 'Name',
  full_name: 'Name',
  timezone: 'Timezone',
  status: 'Status',
  business_day_starts_at: 'Day starts',
  created_at: 'Created',
  key: 'Key',
  is_system: 'Built in',
  category_id: 'Category',
  kind: 'Kind',
  price_minor: 'Price',
  tax_class_key: 'Tax class',
  station_code: 'Station',
  is_combo: 'Combo',
  branch_id: 'Branch',
  display_order: 'Order',
  connection_kind: 'Connection',
  address: 'Address',
  registered_at: 'Registered',
  last_seen_at: 'Last seen',
  revoked_at: 'Revoked',
  gstin: 'GSTIN',
  state_code: 'State code',
  gst_registration: 'GST registration',
  // The choice values, so the buttons read as English rather than as column
  // values. 'Not registered' rather than 'Unregistered': the negative is the
  // consequential answer and it should be unmistakable at a glance.
  registered: 'Registered',
  // 'Composition' is the statutory term and the one an owner's accountant uses,
  // so it is not softened into 'Small scheme' or similar. Somebody on the scheme
  // knows the word; somebody who is not will not pick it by accident.
  composition: 'Composition scheme',
  unregistered: 'Not registered',
  unstated: 'Not answered',
  premises_class: 'Premises',
  // The statutory pair. 'Specified premises' is the term in the notification
  // and in Annexure VII, so it is not softened into 'Luxury' or 'High tariff' --
  // the accountant filing the annexure searches for these two words.
  standard: 'Standard premises',
  specified: 'Specified premises',
};

export function label(column: string): string {
  return LABELS[column] ?? column.replace(/_/g, ' ');
}

/** Columns rendered as money, in minor units. Named, never guessed from a suffix. */
export const MONEY_COLUMNS: readonly string[] = ['price_minor'];

/** Columns rendered as a timestamp. */
export const TIME_COLUMNS: readonly string[] = [
  'created_at', 'registered_at', 'last_seen_at', 'revoked_at',
];

/**
 * Columns whose value is one of a fixed set, offered as a choice rather than
 * typed.
 *
 * ###########################################################################
 * THIS IS A COPY OF A SCHEMA CHECK, SO IT IS GATED.
 *
 * The create form's whole doctrine is that it renders the server's `creatable`
 * and holds no second opinion about what may be written. This is not that: it
 * says how a field is PRESENTED, not whether it may be set. But the values are
 * a vocabulary the schema owns -- `branch_gst_registration_known` -- and no API
 * response carries it, so the list has to live somewhere on the client.
 *
 * A copy that nothing checks is the shape this repo keeps finding, so
 * tests/http/adminSurface.test.ts reads the CHECK out of the catalogue and
 * asserts this list against it. Add a fourth GST position to the constraint and
 * that gate fails; leave a stale one here and it fails too.
 *
 * `unstated` is deliberately absent and is not an omission: it is what migration
 * 0048's backfill wrote onto branches that predate the question, nothing may
 * move a branch into it, and offering it would turn a migration artifact into
 * something an owner could choose.
 * ###########################################################################
 */
export const FIELD_CHOICES: Readonly<Record<string, readonly string[]>> = {
  // Three answers now. Migration 0051 added `composition`, and it had to: a
  // composition dealer holds a GSTIN and may not collect a paisa of tax, which
  // neither of the other two can express. Offering only two forced such a shop
  // to answer 'Registered' -- and then charge diners GST it is forbidden to
  // collect.
  gst_registration: ['registered', 'composition', 'unregistered'],
  // Two answers, and no `unstated`. Unlike the GST position, absence here is
  // not a migration artifact with a value of its own: a branch that has not
  // answered simply has no row for that year, and `app.bill.premises_class`
  // records `unstated` on the document to say so. There is nothing to declare
  // that means "un-declare", because removing a declaration is deleting a tax
  // record rather than stating one -- which is the same thing
  // BadPremisesClassError says to anyone who posts it.
  premises_class: ['standard', 'specified'],
};

/**
 * Fields that STOP APPLYING once a choice is made, and the choice that stops
 * them.
 *
 * ###########################################################################
 * A FIELD WHOSE ONLY POSSIBLE USE IS A REFUSAL SHOULD NOT BE ON THE FORM.
 *
 * `branch_gstin_iff_position_holds_one` is a biconditional: a branch holding
 * neither a registration nor composition status may not hold a GSTIN. So on a create form where 'Not registered'
 * has been chosen, the GSTIN box can do exactly one thing -- earn a 409 naming
 * a constraint -- and `state_code` follows it, because
 * `branch_gstin_matches_state` only relates the two.
 *
 * This mirrors a constraint rather than inventing a rule, which is the only
 * reason a client-side dependency between two fields is acceptable in a form
 * whose whole doctrine is that the server decides what may be written. The
 * fields stay in `creatable`; they are just not asked for when the answer
 * already forbids them.
 * ###########################################################################
 */
export const CHOICE_HIDES: Readonly<Record<string, readonly string[]>> = {
  'gst_registration.unregistered': ['gstin', 'state_code'],
  // `composition` is DELIBERATELY ABSENT from this map, and its absence is the
  // point: a composition dealer IS registered and must supply its GSTIN.
  // `branch_gstin_iff_position_holds_one` requires one, so hiding the field
  // would make the position unreachable from the form.
};

/**
 * Fields taken from another field rather than typed, and where from.
 *
 * `state_code` is the first two digits of the GSTIN -- that is what
 * `branch_gstin_matches_state` asserts, and asking for it separately is a
 * second chance to make the two disagree, for no information gained.
 */
export const DERIVED_PREFIX: Readonly<Record<string, { from: string; length: number }>> = {
  state_code: { from: 'gstin', length: 2 },
};

/**
 * What each choice MEANS, in the words of somebody who runs a restaurant rather
 * than somebody who wrote the schema. Shown under the control, because
 * 'registered' and 'unregistered' are the two most consequential words on the
 * form and neither of them says what happens to the bill.
 */
export const CHOICE_HELP: Readonly<Record<string, string>> = {
  'gst_registration.registered':
    'This branch has a GSTIN and charges GST. Enter the number below — a branch '
    + 'cannot be registered without it.',
  'gst_registration.composition':
    'On the composition scheme: this branch has a GSTIN and pays 5% of its '
    + 'turnover itself, so it must NOT charge GST to a customer. Bills carry no '
    + 'tax and print as a bill of supply. Enter the number below.',
  'gst_registration.unregistered':
    'Below the registration threshold and holding no GSTIN. Bills from this '
    + 'branch carry no GST at all. Change it here the day the registration comes '
    + 'through. (If the shop HAS a GSTIN but is on the composition scheme, that '
    + 'is the answer above, not this one.)',
  'gst_registration.unstated':
    'Nobody has answered this yet, so this branch still charges GST from its menu '
    + 'tax classes. If it is not registered, it is collecting tax it cannot remit — '
    + 'state the position.',
  'premises_class.standard':
    'An ordinary restaurant: 5% on the bill and no input tax credit on what the '
    + 'kitchen buys. This is the answer for almost every branch, and it is the one '
    + 'to state even though it changes nothing — an unanswered year is not the same '
    + 'as a year answered "standard".',
  'premises_class.specified':
    'Any unit on these premises had a declared room tariff above ₹7,500 a day in '
    + 'the PREVIOUS financial year, or the hotel has opted in for this one. Every '
    + 'line billed here is then taxed at 18% — not just the rooms — and input tax '
    + 'credit is available on what the kitchen buys. It is fixed for the whole '
    + 'financial year: it cannot be turned on in October and off in December.',
  'premises_class.unstated':
    'Nobody has answered for this financial year, so bills are being issued at the '
    + 'menu tax classes with no classification recorded on them. If the premises IS '
    + 'specified, every one of those bills is short of tax that is still owed.',
};
