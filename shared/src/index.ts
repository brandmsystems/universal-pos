/**
 * Code shared by the API and the web clients. Only what BOTH sides need, and
 * nothing that reads a database, a DOM or an environment variable: this
 * package must run unchanged in Node and in a browser.
 */
export { EXPIRING_WITHIN_DAYS } from './constants/subscription.js';
export {
  RESERVED_SLUGS, SLUG_PATTERN, SLUG_TAKEN_MESSAGE, SUPERADMIN_SEGMENT, slugProblem, slugify,
} from './constants/slug.js';
export {
  ENTITLEMENTS, PLAN_FEATURES, PLAN_FEATURE_KEYS, PLAN_KEYS, PLAN_LIMITS, PLAN_NAMES,
  REPORT_TIERS, REPORT_TIER_FLAGS, entitlementsFromTerms, getAdminMenu, lowestPlanIncluding,
  planIncludes, planTermsFor, reportTierAllows,
} from './constants/plans.js';
export type {
  AdminMenu, AdminMenuKey, PlanEntitlements, PlanFeature, PlanGate, PlanKey, PlanLimit,
  PlanTermsShape, ReportTier,
} from './constants/plans.js';
export {
  ADDRESS_MAX_LENGTH, ADDRESS_MIN_LENGTH, LOGO_MAX_BYTES, LOGO_TYPES, THEME_COLOR_PATTERN,
  normaliseThemeColor, readableOn,
} from './constants/branding.js';
export type { LogoType } from './constants/branding.js';
export { SETUP_MAX_ROWS_PER_SHEET, SETUP_SHEETS } from './constants/setupSheets.js';
export { counterNumber, describePlace } from './constants/orderPlace.js';
export { COUNTRIES, countryOf, localeForCurrency, minorExponent } from './constants/countries.js';
export type { CountryDefinition } from './constants/countries.js';
export type { OrderPlace } from './constants/orderPlace.js';
export type { SetupColumn, SetupRow, SetupSheet, SetupSheetKey, SetupSheets } from './constants/setupSheets.js';
export {
  PRINTER_DEFAULT_PORT, PRINTER_PORT_MAX, PRINTER_PORT_MIN, parsePrinterAddress, printerAddress, printerAddressProblem,
  printerPortProblem,
} from './constants/printerAddress.js';
export {
  ADMIN_SECTION_KEYS, BUSINESS_TYPES, BUSINESS_TYPE_KEYS, DEFAULT_BUSINESS_TYPE, businessTypeOf,
  isBusinessTypeKey, sectionTitle, selectableBusinessTypes,
  BUSINESS_MODULE_KEYS, CORE_MODULE, defaultModulesFor, isBusinessModuleKey,
} from './constants/businessTypes.js';
export type {
  ModuleGate, AdminSectionKey, BusinessTerms, BusinessTheme, BusinessTypeDefinition, BusinessTypeKey,
  BusinessTypeStatus, BusinessWorkflow,
} from './constants/businessTypes.js';
