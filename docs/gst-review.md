# GST review pack

> **Status: Pending qualified GST review.** Nothing in this document or in the code
> is claimed to be GST-compliant. It describes what the code does today, with
> sample figures produced by the code itself, so that someone who files GST returns
> can confirm or correct it **before the first real invoice**. Record the outcome at
> the foot of this file; until then nothing may be described as GST-approved.

Every sample figure below is asserted by `apps/api/tests/tax/gstSamples.test.ts`, so
this document cannot drift from the code. A reviewer's correction changes the code,
that test and this file together.

---

## 1. Two documents, two flows, no shared code

| | Our invoice to a restaurant | A restaurant's bill to a diner |
|---|---|---|
| Plane | control plane | tenant plane |
| Supplier | the platform's own registration (`platform` data) | the restaurant's branch (`app.branch`) |
| Recipient | the restaurant (`platform.tenant_tax_profile`) | the diner (not identified) |
| Place of supply | `determinePlaceOfSupply` (`modules/billing/placeOfSupply.ts`) | `restaurantSupply` -> `resolveIndianSupply` (`modules/payments/billing.ts`, `modules/tax/in.ts`) |
| Tax per line | `componentsForLine` | `lineTax` + `headsForLine` (`modules/tax/taxHeads.ts`, `registry.ts`) |
| Round off | `roundOffMinor` | `nearestRupeeRoundOff` (rule `nearest_rupee`, 0082) |
| Stored on | `platform.invoice` (+ lines, components) | `app.bill`, `app.bill_line` (heads as jsonb) |
| Return | -- | `modules/reporting/gstReturn.ts` (GST-account bills only) |

The two flows share no code on purpose (a change for one must not alter the other's
filed documents); `tests/ops/taxHeads.test.ts` asserts they split a rate identically.

### Flow: our invoice to a restaurant

1. The restaurant's tax profile is entered: legal name, GSTIN (optional), state,
   country, SEZ flag, LUT number. `assertProfileCoherent` refuses a GSTIN whose
   first two characters contradict the stated state, a GSTIN with a non-IN country,
   and an SEZ or export claim without an LUT.
2. `determinePlaceOfSupply`: outside India -> `export` (place of supply `96`); else
   SEZ -> `sez` (whatever the state); else the GSTIN's state (or the stated state when
   unregistered) compared with ours -> `intra_state` / `inter_state`.
3. `componentsForLine`, per line: export and SEZ carry no tax; inter-state is one
   IGST component; intra-state halves the rate into CGST + SGST (an odd rate in basis
   points is refused), the odd paisa of the amount to CGST.
4. Tax is summed from the lines; `roundOffMinor` brings the total to a whole rupee as
   its own line (bounded to +/-0.50). Everything is snapshotted onto the invoice; a
   deferred trigger refuses an invoice whose components contradict its treatment.
5. The rate (`invoice.gst_rate_bps`) and SAC code (`invoice.sac_code`) are platform
   settings, not constants.

### Flow: a restaurant bill to a diner

1. A dish carries ONE tax class (one rate); the order line snapshots the rate. The
   branch states whether it charges tax, under which account (`none | gst | vat |
   others`) and whether prices include tax (`forward | reverse`), 0083.
2. `restaurantSupply` passes the **branch's state as both supplier and place of
   supply**: restaurant service is supplied where the restaurant is, so a GST bill is
   always `intra_state`. A guest's state is not an input. No tax -> `none`; tax
   charged at a branch with no state code -> `unstated`, which the GST return refuses.
3. Per line, `lineTax` finds the tax (forward: added; reverse: found inside the
   price), and `headsForLine` splits it into CGST + SGST by share, the odd paisa to
   the first head (CGST).
4. The bill total is subtotal + tax; the payable is total + round off to the nearest
   rupee (`nearestRupeeRoundOff`). The bill snapshots the account, mode, GSTIN,
   treatment, jurisdiction and currency.

---

## 2. Sample invoices (produced by the code)

Our supplier registration in the samples: GSTIN `29AAACK1234A1Z5`, Karnataka (29).
Subscription line ₹999.00 at 18% (the rate is an example; the live value is the
platform setting). Sample GSTINs are well-formed placeholders, not real numbers.

### P. Our invoice to a restaurant

| # | Recipient | Treatment | Place of supply | Tax | Round off | Total |
|---|---|---|---|---|---|---|
| P1 | registered, `29AABCR1234B1Z3` (our state) | intra_state | 29 | CGST 9% ₹89.91 + SGST 9% ₹89.91 | +₹0.18 | ₹1,179.00 |
| P2 | registered, `32AABCR1234B1Z3` (Kerala) | inter_state | 32 | IGST 18% ₹179.82 | +₹0.18 | ₹1,179.00 |
| P3 | unregistered (B2C), stated Kerala | inter_state | 32 | IGST 18% ₹179.82 | +₹0.18 | ₹1,179.00 |
| P4 | SEZ unit in **our** state, with LUT | sez | 29 | none (zero-rated) | 0 | ₹999.00 |
| P5 | outside India (AE), with LUT | export | 96 | none (zero-rated) | 0 | ₹999.00 |
| P6 | GSTIN says 32, profile says 29 | refused | -- | `tax_profile_invalid` | -- | -- |
| P7 | SEZ or export without an LUT | refused | -- | `tax_profile_invalid` | -- | -- |
| P8 | a total ending in exactly ₹0.50 | -- | -- | -- | **-₹0.50** (rounds down) | -- |

### R. A restaurant bill to a diner (branch in Kerala, 32)

| # | Case | Result |
|---|---|---|
| R1 | any GST bill, whatever the diner's state | intra_state: CGST + SGST |
| R2 | six dishes, ₹15 + ₹29 + ₹92 + ₹46 + ₹52 + ₹48 = ₹282.00 at 5%, forward | tax per line, total ₹14.10 = **CGST 2.5% ₹7.06 + SGST 2.5% ₹7.04**; total ₹296.10; round off -₹0.10; payable ₹296.00 |
| R3 | ₹105.00 at 5%, prices include tax | taxable ₹100.00, tax ₹5.00 (CGST ₹2.50 + SGST ₹2.50) |
| R4 | tax charged, branch has no state code | `unstated`: no heads; the GST return refuses the period |
| R5 | no tax charged | `none`, branch state kept |
| R6 | branch on the VAT account | `vat`: one VAT head, not a GST supply, not in the GST return |
| R7 | totals ₹264.49 / ₹264.50 / ₹190.05 | -₹0.49 / **+₹0.50** (rounds up) / -₹0.05 |

R2 is the bill printed by the local KFC demo restaurant on 2026-11-16 (Bill No 6),
reproduced exactly.

---

## 3. Assumptions the code makes

1. Restaurant service is supplied where the restaurant is, for dine-in, takeaway and
   parcel alike, so a restaurant bill is never inter-state.
2. The GSTIN's first two characters are the recipient's state, and they override
   the address. A GSTIN is checked by pattern only; its check character is not
   verified.
3. Zero-rated supplies (SEZ, export) are made under LUT only; the pay-IGST-and-claim-
   refund route is deliberately not supported.
4. Tax is computed per line and summed, never as a percentage of a rounded subtotal.
5. A diner is never identified on a bill: no recipient name or GSTIN is recorded.
6. An unregistered branch and a composition dealer charge no tax (rates resolve to 0;
   the database refuses a taxed line in those positions).
7. A GSTIN supplied after B2C invoicing does not trigger re-issue
   (`docs/billing-terms.md`).

## 4. Edge cases already handled

An SEZ unit in our own state (inter-state, P4); a GSTIN contradicting the stated
state (refused, P6); an odd rate on our invoices (refused); an exempt dish beside a
taxable one (no zero-valued head); a part refund of a bill with two rates (refused,
whole-bill refund allowed); historical bills with no recorded state (`unstated`,
refused by the return); a branch changing its tax settings while an order is open
(refused).

## 5. Open questions for the reviewer

1. **Round off at exactly 50 paise goes opposite ways.** Our invoice rounds ₹x.50
   DOWN (P8); a restaurant bill rounds it UP (R7). Which is right for each document,
   or should they agree?
2. **CGST and SGST totals can differ by paise on one bill.** The split is per line and
   the odd paisa goes to CGST each time, so R2 shows CGST ₹7.06 and SGST ₹7.04 on one
   5% bill. Should the split be made once on the bill's total per rate instead?
3. **Restaurant place of supply is always the branch's state.** Confirm for parcel and
   delivery to another state, and for catering at a customer's site (not supported
   today: such a supply would be headed as intra-state).
4. **No diner GSTIN on restaurant bills.** A registered business customer cannot get
   a bill carrying its GSTIN (the company-GSTIN option was removed in 0064). Is that
   acceptable for the restaurants on the platform?
5. **Bills with `unstated` treatment** (tax charged before a branch state was
   recorded) need a decision on how to report them.
6. **E-invoicing (IRN)** is not built, for either document.
7. **Our invoice to a UAE restaurant** is treated as an export of services (P5) and
   needs the evidence-backed zero-rating grant; confirm.
8. The **checklist** at the foot of `docs/billing-terms.md` (numbering per series,
   SAC 997331, B2C presentation) is still unanswered.

---

## Review record

| Date | Reviewer (name, qualification) | Scope | Outcome |
|---|---|---|---|
| -- | -- | -- | **Not yet reviewed** |
