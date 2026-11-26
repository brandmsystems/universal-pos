# Billing terms — clauses that must appear before the first real invoice

This file is the source for the customer-facing billing terms. Each clause exists
because a tenant will otherwise ask a question we cannot answer favourably, and
"we can't do that" has to have been said in advance rather than discovered.

**This document has not been reviewed by a tax professional. It must be, together
with the place-of-supply logic and one sample invoice of each treatment, before a
single real invoice is issued.**

---

## 1. Tax registration and input tax credit

Your invoices are issued against the GST registration details on your account at
the time each invoice is generated. Place of supply is determined from your GSTIN
where one is registered with us, and from your billing address otherwise.

**If you register for GST after we have already invoiced you, we cannot reissue
earlier invoices against your new GSTIN.** Those invoices were correct for your
registration status at the time they were issued, and we do not cancel and reissue
a correct document. Input tax credit for those earlier periods will not be
available to you.

*Why this is stated:* a restaurant that registers for GST in month three will ask
for months one and two to be reissued. Reissuing would mean cancelling documents
that were accurate when made — a credit note under Section 34 records a reduction
in the taxable value of a supply already made, not a change in the customer's
registration status. Add your GSTIN before your first invoice if you intend to
claim credit.

## 2. Zero-rated supply

Zero rating for an SEZ unit or for a recipient outside India is applied only after
we have received and verified supporting evidence — the SEZ Letter of Approval, or
equivalent — and it is applied by us, not selected by you.

We supply zero-rated under Letter of Undertaking. We do not operate the
pay-IGST-and-claim-refund route.

## 3. Plan changes

**Upgrades and seat increases take effect immediately** and are charged for the
remainder of the current billing period, shown as a separate line on your next
invoice.

**Downgrades and seat decreases take effect at the end of your current billing
period.** You keep everything you have paid for until then. Nothing is forfeited,
and nothing is refunded, because no unpaid-for period ever arises.

A scheduled downgrade is shown on your billing page and **may be cancelled at any
time before it takes effect**.

**A downgrade that would leave you above the limits of the lower plan will not be
applied.** Your subscription remains on its current plan and we will contact you.
We will not disable locations, users or data you are actively using in order to
fit a smaller plan.

## 4. Cancellation

On cancellation we issue a final invoice covering any period since your last
invoice. Cancelling does not waive amounts already accrued.

## 5. Failed payments

A failed payment does not immediately restrict your account. We retry on a
published schedule, and access is reduced in stages, beginning with a notice
only. Full access is restored as soon as payment succeeds.

## 6. Invoice numbering and corrections

Invoices carry a consecutive number within a series identified to your account and
your financial year. **An issued invoice is never edited.** Where a correction is
genuinely required, we issue a credit note in a separate series and reference it.

---

## Reviewer checklist — for the person who files GST returns

Please confirm, against one sample invoice of each treatment:

1. **intra-state** (recipient in our state): CGST + SGST at equal halves of the
   headline rate, place of supply equal to our state.
2. **inter-state** (recipient in another state): IGST only, place of supply equal
   to the recipient's state.
3. **SEZ recipient in our own state**: treated as inter-state and zero-rated. This
   is the case a naive state comparison gets wrong, so it is worth looking at
   specifically.
4. **export** (recipient outside India): zero-rated under LUT, place of supply
   coded 96, LUT number printed.
5. **B2C** (no GSTIN): place of supply from the billing address; confirm the
   presentation and the threshold rules for inter-state B2C.
6. **Numbering**: a consecutive series per account per financial year, with the
   series identifiable in the number. Confirm this satisfies Rule 46 as parallel
   series rather than requiring one global sequence.
7. **Round off**: presented as its own line, bounded to ±0.50.
8. **SAC code** 997331 — confirm this is the right classification for the service
   as sold.
