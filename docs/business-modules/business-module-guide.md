# Business module guide

Each business type is one entry in `shared/src/constants/businessTypes.ts`.

| Type | Status | Workflow | Notes |
|---|---|---|---|
| `restaurant` | available | `kitchen_order` | dine-in, parcels, kitchen tickets, printers |
| `general_retail` | preview | `counter_sale` | products with barcodes, scan box, no kitchen |
| `optical`, `clothing`, `supermarket`, `mobile`, `salon` | planned | `counter_sale` | defined, cannot be selected yet |

`available` = its own workflow end to end; `preview` = selectable, runs on the
shared order flow; `planned` = shape fixed, not selectable.

## Adding or finishing a type

1. Edit its registry entry (terms, nav, theme, modules).
2. If it needs a new catalogue kind, add a migration (a new `menu_item.kind`, with a
   positive discriminator - never a relaxed CHECK) and teach `fireOrder`,
   `markReadyForBilling` and the adjustment gate what the kind means.
3. Keep type-specific code in its own module; the common engine (order, bill, tender,
   receipt, day-end) is shared and must not be copied.
4. Tests: the registry tests (`backend/tests/platform/businessType.test.ts`,
   `frontend/tests/businessTypes.test.tsx`) walk every type and fail until the
   migration CHECK and the stylesheet agree.

Selecting a type is control-plane only, and the type is fixed once the business has
taken an order.
