/**
 * The business-type registry: the ONE definition of what kinds of business
 * UniversalPOS serves and how each one presents itself.
 *
 * The database stores only a type's `key` (`platform.tenant.business_type`,
 * text + CHECK). Everything else -- the words, the manager navigation, the
 * theme -- is read from here by the API and by every web client, so a type
 * added in one place cannot be missing in another. A test asserts the CHECK in
 * the schema lists exactly these keys.
 *
 * `status` is what a type can honestly do TODAY:
 *   available  its own workflow exists end to end
 *   preview    can be selected, but runs on the shared order flow until its own
 *              checkout ships; the Super Admin picker says so
 *   planned    defined here so the shape is fixed; cannot be selected yet
 */

export const BUSINESS_TYPE_KEYS = [
  'restaurant', 'optical', 'clothing', 'supermarket', 'mobile', 'salon', 'general_retail',
] as const;
export type BusinessTypeKey = (typeof BUSINESS_TYPE_KEYS)[number];

export const DEFAULT_BUSINESS_TYPE: BusinessTypeKey = 'restaurant';

export type BusinessTypeStatus = 'available' | 'preview' | 'planned';

/**
 * Every manager-screen section there is, by its address segment (`''` is the
 * dashboard). The manager navigation is built from this list, so a type's `nav`
 * can only name a screen that exists.
 */
export const ADMIN_SECTION_KEYS = [
  '', 'access', 'orders', 'bills', 'setup', 'menu', 'tax', 'printed-bill',
  'branches', 'roles', 'kitchens', 'printers', 'tablets',
] as const;
export type AdminSectionKey = (typeof ADMIN_SECTION_KEYS)[number];

/** The words a screen uses for the things a business sells and does. */
export interface BusinessTerms {
  /** One thing sold, singular and plural: Dish, Frame, Product, Service. */
  readonly item: string;
  readonly items: string;
  /** One completed transaction: Order, Sale, Appointment. */
  readonly sale: string;
  readonly sales: string;
  readonly customer: string;
  readonly customers: string;
  /** The place the business is run from: Restaurant, Shop, Salon. */
  readonly business: string;
}

export interface BusinessTheme {
  /** Written to `data-business-theme` on the document root; the stylesheets key on it. */
  readonly id: string;
  /**
   * The accent used when the business has set no colour of its own, as
   * lowercase `#rrggbb` (the form the theme code accepts); `null` means the
   * product's own colours, which is what a restaurant has always had.
   */
  readonly primary: string | null;
  /** `soft` is the product's own corner radius; the others restyle every control. */
  readonly radius: 'sharp' | 'soft' | 'round';
}

/**
 * The shape of the till's order screen. `kitchen_order` opens an order, sends it
 * to a kitchen and hands it to billing (dine-in, parcels, kitchen tickets);
 * `counter_sale` scans or picks products and goes straight to billing, with no
 * kitchen, table or parcel. The screen is chosen by this, never by a type's name.
 */
export type BusinessWorkflow = 'kitchen_order' | 'counter_sale';

export interface BusinessTypeDefinition {
  readonly key: BusinessTypeKey;
  readonly label: string;
  readonly description: string;
  readonly status: BusinessTypeStatus;
  readonly workflow: BusinessWorkflow;
  readonly terms: BusinessTerms;
  /** Manager sections shown, in order. Plan gates and permissions still apply on top. */
  readonly nav: readonly AdminSectionKey[];
  /** Section titles that differ from the default, by section. */
  readonly navLabels: Readonly<Partial<Record<AdminSectionKey, string>>>;
  /** Feature modules this type is built from; names a unit of work, not a screen. */
  readonly modules: readonly string[];
  readonly theme: BusinessTheme;
}

const ALL_SECTIONS: readonly AdminSectionKey[] = ADMIN_SECTION_KEYS;
const NO_TABLE_SECTIONS: readonly AdminSectionKey[] = ADMIN_SECTION_KEYS.filter(
  (section) => section !== 'orders' && section !== 'kitchens');

export const BUSINESS_TYPES: Readonly<Record<BusinessTypeKey, BusinessTypeDefinition>> = {
  restaurant: {
    key: 'restaurant', label: 'Restaurant / Hotel', status: 'available', workflow: 'kitchen_order',
    description: 'Dine-in and parcels, kitchen tickets, bills and payments.',
    terms: {
      item: 'Dish', items: 'Dishes', sale: 'Order', sales: 'Orders',
      customer: 'Guest', customers: 'Guests', business: 'Restaurant',
    },
    nav: ALL_SECTIONS,
    navLabels: { menu: 'Menu items', orders: 'Open orders', kitchens: 'Kitchens', tablets: 'Tablets' },
    modules: ['pos', 'menu', 'tables', 'kitchen', 'kot', 'printing'],
    theme: { id: 'restaurant', primary: null, radius: 'soft' },
  },
  general_retail: {
    key: 'general_retail', label: 'General retail', status: 'preview', workflow: 'counter_sale',
    description: 'Products and categories, inventory, billing and returns for any shop.',
    terms: {
      item: 'Product', items: 'Products', sale: 'Sale', sales: 'Sales',
      customer: 'Customer', customers: 'Customers', business: 'Shop',
    },
    nav: NO_TABLE_SECTIONS,
    navLabels: { menu: 'Products', bills: 'Sales and bills', tablets: 'Counters' },
    modules: ['pos', 'products', 'inventory', 'billing', 'returns'],
    theme: { id: 'retail', primary: '#2563eb', radius: 'sharp' },
  },
  optical: {
    key: 'optical', label: 'Optical shop', status: 'planned', workflow: 'counter_sale',
    description: 'Frames and lenses, prescriptions and eye-power records.',
    terms: {
      item: 'Frame', items: 'Frames & lenses', sale: 'Sale', sales: 'Sales',
      customer: 'Patient', customers: 'Patients', business: 'Optical shop',
    },
    nav: NO_TABLE_SECTIONS,
    navLabels: { menu: 'Frames & lenses', bills: 'Sales and bills' },
    modules: ['pos', 'products', 'variants', 'prescriptions', 'customer_vision_records', 'inventory'],
    theme: { id: 'optical', primary: '#0f766e', radius: 'round' },
  },
  clothing: {
    key: 'clothing', label: 'Clothing shop', status: 'planned', workflow: 'counter_sale',
    description: 'Sizes and colours, barcode labels, stock by variant and exchanges.',
    terms: {
      item: 'Garment', items: 'Garments', sale: 'Sale', sales: 'Sales',
      customer: 'Customer', customers: 'Customers', business: 'Store',
    },
    nav: NO_TABLE_SECTIONS,
    navLabels: { menu: 'Garments', bills: 'Sales and bills' },
    modules: ['pos', 'products', 'variants', 'barcode_labels', 'exchanges', 'inventory'],
    theme: { id: 'clothing', primary: '#be185d', radius: 'round' },
  },
  supermarket: {
    key: 'supermarket', label: 'Supermarket', status: 'planned', workflow: 'counter_sale',
    description: 'Barcode-first checkout, weighed and bulk goods, expiry and batches.',
    terms: {
      item: 'Product', items: 'Products', sale: 'Sale', sales: 'Sales',
      customer: 'Customer', customers: 'Customers', business: 'Store',
    },
    nav: NO_TABLE_SECTIONS,
    navLabels: { menu: 'Products', bills: 'Sales and bills', tablets: 'Checkouts' },
    modules: ['pos', 'products', 'barcode_checkout', 'weighing', 'batches_expiry', 'inventory'],
    theme: { id: 'supermarket', primary: '#15803d', radius: 'sharp' },
  },
  mobile: {
    key: 'mobile', label: 'Mobile shop', status: 'planned', workflow: 'counter_sale',
    description: 'IMEI and serial numbers, warranty, accessories, repairs.',
    terms: {
      item: 'Device', items: 'Devices & accessories', sale: 'Sale', sales: 'Sales',
      customer: 'Customer', customers: 'Customers', business: 'Shop',
    },
    nav: NO_TABLE_SECTIONS,
    navLabels: { menu: 'Devices & accessories', bills: 'Sales and bills' },
    modules: ['pos', 'products', 'serial_numbers', 'warranty', 'repairs', 'inventory'],
    theme: { id: 'mobile', primary: '#4f46e5', radius: 'soft' },
  },
  salon: {
    key: 'salon', label: 'Salon / Spa', status: 'planned', workflow: 'counter_sale',
    description: 'Services and packages, appointments, staff assignment, client history.',
    terms: {
      item: 'Service', items: 'Services', sale: 'Appointment', sales: 'Appointments',
      customer: 'Client', customers: 'Clients', business: 'Salon',
    },
    nav: NO_TABLE_SECTIONS,
    navLabels: { menu: 'Services', bills: 'Appointments and bills', access: 'Staff' },
    modules: ['pos', 'services', 'appointments', 'staff_assignment', 'packages', 'client_history'],
    theme: { id: 'salon', primary: '#9333ea', radius: 'round' },
  },
};

export function isBusinessTypeKey(value: unknown): value is BusinessTypeKey {
  return typeof value === 'string' && (BUSINESS_TYPE_KEYS as readonly string[]).includes(value);
}

/** An unknown key reads as the default rather than throwing: an older API sends none. */
export function businessTypeOf(key: string | null | undefined): BusinessTypeDefinition {
  return isBusinessTypeKey(key) ? BUSINESS_TYPES[key] : BUSINESS_TYPES[DEFAULT_BUSINESS_TYPE];
}

/** The types a Super Admin may pick today: everything not merely planned. */
export function selectableBusinessTypes(): readonly BusinessTypeDefinition[] {
  return BUSINESS_TYPE_KEYS.map((key) => BUSINESS_TYPES[key]).filter((type) => type.status !== 'planned');
}

/** The title a manager section shows for this type, falling back to the screen's own. */
export function sectionTitle(type: BusinessTypeDefinition, section: AdminSectionKey, fallback: string): string {
  return type.navLabels[section] ?? fallback;
}

/** The module every business has and no one may switch off: the till itself. */
export const CORE_MODULE = 'pos';

/** Every module any type is built from -- derived from the registry, never listed twice. */
export const BUSINESS_MODULE_KEYS: readonly string[] = [
  ...new Set(BUSINESS_TYPE_KEYS.flatMap((key) => BUSINESS_TYPES[key].modules)),
];

export function isBusinessModuleKey(value: unknown): value is string {
  return typeof value === 'string' && BUSINESS_MODULE_KEYS.includes(value);
}

/** What a new tenant of this type starts with: the type's own modules, as the wizard pre-ticks them. */
export function defaultModulesFor(type: string | null | undefined): readonly string[] {
  return businessTypeOf(type).modules;
}

/** A route that belongs to a module: refused (402 `module_disabled`) unless the tenant has it on. */
export interface ModuleGate {
  readonly module: string;
}
