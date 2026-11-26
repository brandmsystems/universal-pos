import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { Building2, Heading, Percent, Printer, Settings2, ShoppingBag } from 'lucide-react';
import { ApiError, type Api } from '../../../services/api.js';
import { known, stale, unknown, type Remote } from '../../../lib/remote.js';
import { currentCurrency, formatMinor, minorFrom, minorFromTyped, typedFromMinor } from '../../../lib/money.js';
import { TableSkeleton } from '../../../components/admin/skeletons.js';
import { Missing } from '../../../components/admin/missing.js';
import { DoneBanner, RefusalBanner } from '../../../components/admin/banner.js';
import { Button } from '@/components/ui/button.js';
import { cn } from 'cn';
import { Input } from '@/components/ui/input.js';
import { Card } from '@/components/ui/card.js';
import { Switch } from '@/components/ui/switch.js';
import {
  DEFAULT_HEADINGS, DEFAULT_LAYOUT, HEADING_MAX, PAPER, PRINTER_TYPES, headingProblem, papersFor,
  type CopyPage, type Orientation, type PaperSize, type PrintLayout, type PrintedBill as PrintedBillDoc, type PrinterType,
} from '../print/receipt.js';
import { PrintPreview } from '../print/PrintPreview.js';
import { PrinterConnection } from '../print/PrinterConnection.js';
import { sendCopies } from '../print/serialPrinter.js';

/**
 * How a branch's bill is printed: which printer it is laid out for, that
 * printer's paper, what the bill shows, which copies print and whether they
 * print by themselves once an order is paid. Kept per branch, because two
 * outlets have two printers and two phone numbers. The preview is drawn by the
 * same renderer the POS prints with, filled with an example order -- the
 * figures in it are made up and say so; everything else is this branch's.
 *
 * The parcel charge sits here too (0081), because it is a line on this bill:
 * what the till fills in, the most it may charge, and the tax it takes. The
 * database refuses a charge with no tax rate and a default above the maximum;
 * this page says so before it asks.
 *
 * So do the company details the bill prints and how the branch charges tax
 * (0083). The tax settings go to their own route, which refuses them while an
 * order is open; the server computes every figure, this page only chooses.
 */

interface Branch {
  readonly id: string;
  readonly name: string;
  readonly status: string;
  readonly gstin: string | null;
  readonly phone: string | null;
  readonly bill_address: string | null;
  readonly bill_footer: string;
  readonly bill_printer_id: string | null;
  readonly bill_show_logo: boolean;
  readonly bill_show_details: boolean;
  readonly bill_show_customer: boolean;
  readonly bill_show_tax: boolean;
  readonly bill_show_payments: boolean;
  readonly bill_copy_customer: boolean;
  readonly bill_copy_kitchen: boolean;
  readonly bill_copy_counter: boolean;
  readonly bill_auto_print: boolean;
  readonly bill_show_copy_label: boolean;
  /** The headings (0088). Absent from an older API: the defaults. */
  readonly bill_heading_unpaid?: string;
  readonly bill_heading_part_paid?: string;
  readonly bill_heading_paid?: string;
  readonly parcel_charge_default_minor: string | number;
  readonly parcel_charge_max_minor: string | number;
  readonly parcel_charge_tax_class_id: string | null;
  readonly email: string | null;
  readonly bill_name: string | null;
  readonly tax_enabled: boolean;
  readonly tax_account_type: TaxAccount;
  readonly tax_calculation_mode: TaxMode;
  readonly tax_registration_no: string | null;
}

type TaxAccount = 'none' | 'gst' | 'vat' | 'others';
type TaxMode = 'forward' | 'reverse';
interface TaxForm { readonly enabled: boolean; readonly account: TaxAccount; readonly mode: TaxMode; readonly number: string }

const ACCOUNT_LABEL: Record<TaxAccount, string> = { none: 'NONE', gst: 'GST', vat: 'VAT', others: 'OTHERS' };
/** What the bill calls the tax, by account: the same words the server prints. */
const TAX_WORD: Record<TaxAccount, string> = { none: 'Tax', gst: 'GST', vat: 'VAT', others: 'Tax' };
/** The registration number's name on the bill, by account. */
const NUMBER_LABEL: Record<TaxAccount, string> = { none: '', gst: 'GSTIN', vat: 'TRN', others: 'Tax No.' };

interface TaxClassRow { readonly id: string; readonly name: string; readonly rate_bps: number; readonly status: string }

/** 500 -> "5%": a rate in basis points, for the tax-rate choice. */
const pctOfBps = (rateBps: number): string => `${String(Number((rateBps / 100).toFixed(2)))}%`;

interface ChargeForm { readonly defaultText: string; readonly maxText: string; readonly taxClassId: string | null }

/** What the manager typed, as the three columns -- or the sentence that stops the save. */
function chargeColumns(charge: ChargeForm): {
  columns: { parcel_charge_default_minor: number; parcel_charge_max_minor: number; parcel_charge_tax_class_id: string | null } | null;
  problem: string | null;
} {
  const max = charge.maxText.trim() === '' ? 0 : minorFromTyped(charge.maxText);
  const dflt = charge.defaultText.trim() === '' ? 0 : minorFromTyped(charge.defaultText);
  if (max === null || dflt === null) return { columns: null, problem: 'Enter parcel charges as amounts, like 20 or 20.50.' };
  if (max > 0 && charge.taxClassId === null) {
    return { columns: null, problem: 'Choose the tax rate for parcel charges: packing is taxed with the food.' };
  }
  if (dflt > max) return { columns: null, problem: 'The charge the till fills in cannot be more than the most it may charge.' };
  return {
    columns: { parcel_charge_default_minor: dflt, parcel_charge_max_minor: max, parcel_charge_tax_class_id: charge.taxClassId },
    problem: null,
  };
}

interface PrinterRow {
  readonly id: string;
  readonly name: string;
  readonly connection_kind: string;
  readonly address: string | null;
  readonly status: string;
  readonly printer_type: PrinterType;
  readonly paper_size: PaperSize;
  readonly orientation: Orientation;
  readonly margin_mm: number;
  readonly font_size_px: number;
}

const CONNECTION: Record<string, string> = {
  network: 'Wi-Fi / Ethernet LAN', usb: 'USB', bluetooth: 'Bluetooth', cloud: 'Cloud',
};

/** What each connection can really do -- said plainly, never more. */
function connectionNote(kind: string | null): string {
  if (kind === 'network') {
    return 'Kitchen tickets are sent to this printer by the server, which reaches it only when the server runs on the '
      + 'restaurant’s own network — the hosted site cannot reach a 192.168… address yet. Bills print through this '
      + 'computer’s print dialog, so add the printer to this computer as well to print bills on it.';
  }
  if (kind === null) return 'Bills print through this computer’s print dialog on whichever printer you pick there.';
  return 'Connected on a till (the Printer button on the POS, or below), bills print on it directly with no print '
    + 'dialog. Otherwise they print through this computer’s print dialog: install the printer in Windows on its USB '
    + 'port, or on the COM port Windows gives it when paired over Bluetooth — not a TCP/IP port. The server cannot '
    + 'reach a USB or Bluetooth printer, so kitchen tickets for it are printed from the till.';
}

/**
 * The example's tax, by setting: made-up figures, stated rather than worked out
 * here. Forward adds 5% to 550.00; reverse finds the 5% inside it; NONE or off
 * charges none.
 */
function exampleTax(tax: TaxForm): Pick<PrintedBillDoc, 'subtotalMinor' | 'taxes' | 'taxMinor' | 'totalMinor' | 'pricesIncludeTax' | 'taxLabel'> {
  const account = tax.enabled ? tax.account : 'none';
  if (account === 'none') return { subtotalMinor: 55000, taxes: [], taxMinor: 0, totalMinor: 55000, pricesIncludeTax: false, taxLabel: null };
  const reverse = tax.mode === 'reverse';
  const [taxable, total, half, whole] = reverse ? [52381, 55000, [1310, 1309], 2619] : [55000, 57750, [1375, 1375], 2750];
  const taxes = account === 'gst'
    ? [{ label: 'CGST 2.5%', amountMinor: half[0]! }, { label: 'SGST 2.5%', amountMinor: half[1]! }]
    : [{ label: `${account === 'vat' ? 'VAT' : 'TAX'} 5%`, amountMinor: whole }];
  return { subtotalMinor: taxable, taxes, taxMinor: whole, totalMinor: total, pricesIncludeTax: reverse, taxLabel: TAX_WORD[account] };
}

const EXAMPLE: Omit<PrintedBillDoc, 'restaurant' | 'layout'> = {
  kind: 'receipt', copyNo: 1, currency: 'INR', timezone: 'Asia/Kolkata', billNo: 14,
  businessDate: '2026-10-02', openedAt: '2026-10-02T13:35:00Z', billedAt: '2026-10-02T15:11:00Z',
  settledAt: '2026-10-02T15:12:00Z', printedAt: '2026-10-02T15:12:00Z', serviceType: 'parcel', tables: [],
  parcelNo: 3, pickupName: 'Customer name', covers: null, waiter: 'Staff name', cashier: 'Cashier name',
  lines: [
    { quantity: 2, name: 'Example dish', rateMinor: 25000, grossMinor: 50000, addOns: ['Example add-on'], lessMinor: 0, lessLabel: null },
    { quantity: 1, name: 'Example drink', rateMinor: 5000, grossMinor: 5000, addOns: [], lessMinor: 0, lessLabel: null },
  ],
  subtotalMinor: 55000,
  taxes: [{ label: 'CGST 2.5%', amountMinor: 1375 }, { label: 'SGST 2.5%', amountMinor: 1375 }],
  taxMinor: 2750,
  totalMinor: 57750,
  tenders: [{ method: 'cash', amountMinor: 57750, reference: null, cashReceivedMinor: 60000, changeMinor: 2250 }],
  paidMinor: 57750, outstandingMinor: 0,
};

/** Which example the preview shows: a bill with nothing paid, some paid, or all of it. */
type ExampleState = 'unpaid' | 'part' | 'paid';
const EXAMPLE_STATES: readonly { readonly value: ExampleState; readonly label: string }[] = [
  { value: 'unpaid', label: 'Unpaid' }, { value: 'part', label: 'Part paid' }, { value: 'paid', label: 'Paid' },
];

/** The example order at that state: what the server would send for it. Made-up figures, as above. */
function exampleAt(
  state: ExampleState, totalMinor: number,
): Pick<PrintedBillDoc, 'kind' | 'settledAt' | 'tenders' | 'paidMinor' | 'outstandingMinor'> {
  if (state === 'unpaid') return { kind: 'bill', settledAt: null, tenders: [], paidMinor: 0, outstandingMinor: totalMinor };
  if (state === 'part') {
    const part = 20000;
    return {
      kind: 'bill', settledAt: null, paidMinor: part, outstandingMinor: totalMinor - part,
      tenders: [{ method: 'upi', amountMinor: part, reference: null, cashReceivedMinor: null, changeMinor: 0 }],
    };
  }
  const handed = Math.ceil(totalMinor / 10000) * 10000;
  return {
    kind: 'receipt', settledAt: EXAMPLE.settledAt, paidMinor: totalMinor, outstandingMinor: 0,
    tenders: [{ method: 'cash', amountMinor: totalMinor, reference: null, cashReceivedMinor: handed, changeMinor: handed - totalMinor }],
  };
}

/** Headings managers often print, suggested as they type. Any other text may be typed. */
const HEADING_IDEAS = ['BILL', 'PART PAID', 'INVOICE', 'TAX INVOICE', 'CASH RECEIPT', 'PAYMENT RECEIPT', 'RESTAURANT BILL', 'RECEIPT'];
/** One tap for the heading most often changed: the fully paid bill's. */
const PAID_IDEAS = ['INVOICE', 'TAX INVOICE', 'CASH RECEIPT', 'PAYMENT RECEIPT', 'RECEIPT'];

type HeadingKey = 'bill_heading_unpaid' | 'bill_heading_part_paid' | 'bill_heading_paid';
const HEADING_FIELDS: readonly {
  readonly key: HeadingKey; readonly label: string; readonly state: ExampleState; readonly fallback: string; readonly hint: string;
}[] = [
  { key: 'bill_heading_unpaid', label: 'Unpaid bill', state: 'unpaid', fallback: DEFAULT_HEADINGS.unpaid,
    hint: 'Printed before any payment.' },
  { key: 'bill_heading_part_paid', label: 'Part-paid bill', state: 'part', fallback: DEFAULT_HEADINGS.partPaid,
    hint: 'Printed after some of it is paid, with the balance due.' },
  { key: 'bill_heading_paid', label: 'Fully paid bill', state: 'paid', fallback: DEFAULT_HEADINGS.paid,
    hint: 'Printed once it is paid in full.' },
];

const EXAMPLE_TICKET = {
  ticketText: 'KOT #3   send 1\n02/10/2026 20:41\nPARCEL P-3 Customer name\nKitchen: Main\n--------------------------------\n 2 x Example dish\n     + Example add-on\n     * less spicy\n 1 x Example drink\n--------------------------------\n3 items',
};

/**
 * The columns this page edits, named rather than "everything the row had": the
 * branch list also returns `code`, `state_code` and `gst_registration`, which this
 * route refuses, and the server refuses the WHOLE save over one of them.
 */
const BILL_FIELDS = [
  'phone', 'email', 'bill_name', 'bill_address', 'bill_footer', 'bill_printer_id', 'bill_show_logo', 'bill_show_details',
  'bill_show_customer', 'bill_show_tax', 'bill_show_payments', 'bill_copy_customer', 'bill_copy_kitchen',
  'bill_copy_counter', 'bill_auto_print', 'bill_show_copy_label', 'bill_heading_unpaid', 'bill_heading_part_paid',
  'bill_heading_paid',
] as const;
type BillForm = Required<Pick<Branch, (typeof BILL_FIELDS)[number]>>;
const billForm = (branch: Branch): BillForm => ({
  ...(Object.fromEntries(BILL_FIELDS.map((key) => [key, branch[key]])) as unknown as BillForm),
  bill_heading_unpaid: branch.bill_heading_unpaid ?? DEFAULT_HEADINGS.unpaid,
  bill_heading_part_paid: branch.bill_heading_part_paid ?? DEFAULT_HEADINGS.partPaid,
  bill_heading_paid: branch.bill_heading_paid ?? DEFAULT_HEADINGS.paid,
});
type PrinterForm = Pick<PrinterRow, 'printer_type' | 'paper_size' | 'orientation' | 'margin_mm' | 'font_size_px'>;

export function PrintedBill(props: { api: Api; restaurantName: string; logoUrl?: string | null }): ReactElement {
  const [branches, setBranches] = useState<Remote<readonly Branch[]>>(unknown<readonly Branch[]>());
  const [branchId, setBranchId] = useState<string | null>(null);
  const [printers, setPrinters] = useState<readonly PrinterRow[]>([]);
  const [form, setForm] = useState<BillForm | null>(null);
  const [printerForm, setPrinterForm] = useState<PrinterForm | null>(null);
  const [charge, setCharge] = useState<ChargeForm>({ defaultText: '', maxText: '', taxClassId: null });
  const [taxClasses, setTaxClasses] = useState<readonly TaxClassRow[]>([]);
  const [tax, setTax] = useState<TaxForm>({ enabled: true, account: 'gst', mode: 'forward', number: '' });
  // The accounts this restaurant's country has: a UAE restaurant is offered no GST.
  const [accounts, setAccounts] = useState<readonly TaxAccount[]>(['none', 'gst', 'vat', 'others']);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [example, setExample] = useState<ExampleState>('paid');

  const read = useCallback(async (): Promise<void> => {
    try {
      const body = await props.api.get<{ rows: readonly Branch[] }>('/admin/branches');
      setBranches(known(body.rows.filter((b) => b.status === 'active')));
    } catch (error) {
      setBranches((current) =>
        error instanceof ApiError && error.failure.kind === 'offline'
          ? stale(current)
          : unknown<readonly Branch[]>(
            error instanceof ApiError && error.failure.kind === 'refused'
              && error.failure.status === 403 ? 'not-permitted' : 'read-failed'));
    }
  }, [props.api]);
  useEffect(() => { void read(); }, [read]);
  useEffect(() => {
    void props.api.get<{ rows: readonly TaxClassRow[] }>('/admin/tax-classes')
      .then((body) => setTaxClasses(body.rows.filter((t) => t.status === 'active')))
      .catch(() => setTaxClasses([]));
    void props.api.get<{ accounts?: readonly TaxAccount[] }>('/admin/tax-splits')
      .then((body) => { if (body.accounts !== undefined && body.accounts.length > 0) setAccounts(body.accounts); })
      .catch(() => undefined);
  }, [props.api]);

  const rows = branches.state === 'unknown' ? [] : branches.value;
  const branch = rows.find((b) => b.id === branchId) ?? rows[0] ?? null;

  const readPrinters = useCallback(async (id: string): Promise<void> => {
    try {
      const body = await props.api.get<{ rows: readonly PrinterRow[] }>(`/admin/printers?branchId=${encodeURIComponent(id)}`);
      setPrinters(body.rows.filter((p) => p.status === 'active'));
    } catch {
      setPrinters([]);
    }
  }, [props.api]);
  useEffect(() => { if (branch !== null) void readPrinters(branch.id); }, [branch?.id, readPrinters]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (branch === null) return;
    setForm(billForm(branch));
    setCharge({
      defaultText: typedFromMinor(minorFrom(branch.parcel_charge_default_minor)),
      maxText: typedFromMinor(minorFrom(branch.parcel_charge_max_minor)),
      taxClassId: branch.parcel_charge_tax_class_id,
    });
    setTax({
      enabled: branch.tax_enabled, account: branch.tax_account_type, mode: branch.tax_calculation_mode,
      number: branch.tax_registration_no ?? '',
    });
  }, [branch]);

  const setTaxField = <K extends keyof TaxForm>(key: K, value: TaxForm[K]): void => {
    setTax((current) => ({ ...current, [key]: value }));
    setDone(null);
  };
  const taxChanged = branch !== null && (tax.enabled !== branch.tax_enabled || tax.account !== branch.tax_account_type
    || tax.mode !== branch.tax_calculation_mode || tax.number.trim().toUpperCase() !== (branch.tax_registration_no ?? ''));
  const takesNumber = tax.account === 'vat' || tax.account === 'others';

  const printer = printers.find((p) => p.id === form?.bill_printer_id) ?? null;
  useEffect(() => {
    setPrinterForm(printer === null ? null : {
      printer_type: printer.printer_type, paper_size: printer.paper_size, orientation: printer.orientation,
      margin_mm: printer.margin_mm, font_size_px: printer.font_size_px,
    });
  }, [printer]);

  const set = <K extends keyof BillForm>(key: K, value: BillForm[K]): void => {
    setForm((current) => current === null ? current : { ...current, [key]: value });
    setDone(null);
  };
  const setPrinter = <K extends keyof PrinterForm>(key: K, value: PrinterForm[K]): void => {
    setPrinterForm((current) => {
      if (current === null) return current;
      const next = { ...current, [key]: value };
      // Keep the pair the table's CHECKs require: a roll with a thermal printer, portrait on a roll.
      if (key === 'printer_type' && !papersFor(next.printer_type).includes(next.paper_size)) {
        next.paper_size = papersFor(next.printer_type)[1]!; // 3-inch roll, or A4
      }
      if (PAPER[next.paper_size].roll) next.orientation = 'portrait';
      return next;
    });
    setDone(null);
  };

  const layout = useMemo((): PrintLayout => {
    if (form === null) return DEFAULT_LAYOUT;
    return {
      printerName: printer?.name ?? null,
      connection: printer?.connection_kind ?? null,
      printerType: printerForm?.printer_type ?? DEFAULT_LAYOUT.printerType,
      paperSize: printerForm?.paper_size ?? DEFAULT_LAYOUT.paperSize,
      orientation: printerForm?.orientation ?? DEFAULT_LAYOUT.orientation,
      marginMm: printerForm?.margin_mm ?? DEFAULT_LAYOUT.marginMm,
      fontSizePx: printerForm?.font_size_px ?? DEFAULT_LAYOUT.fontSizePx,
      show: {
        logo: form.bill_show_logo, details: form.bill_show_details, customer: form.bill_show_customer,
        tax: form.bill_show_tax, payments: form.bill_show_payments, copyLabel: form.bill_show_copy_label,
      },
      copies: { customer: form.bill_copy_customer, kitchen: form.bill_copy_kitchen, counter: form.bill_copy_counter },
      autoPrint: form.bill_auto_print,
      headings: { unpaid: form.bill_heading_unpaid, partPaid: form.bill_heading_part_paid, paid: form.bill_heading_paid },
    };
  }, [form, printer, printerForm]);

  const pages = useMemo((): CopyPage[] => {
    if (form === null) return [];
    const taxed = exampleTax(tax);
    const doc: PrintedBillDoc = {
      ...EXAMPLE,
      currency: currentCurrency(),
      layout,
      ...taxed,
      ...exampleAt(example, taxed.totalMinor),
      restaurant: {
        name: (form.bill_name ?? '').trim() === '' ? props.restaurantName : form.bill_name!.trim(),
        legalName: null,
        address: (form.bill_address ?? '').trim() === '' ? '(the restaurant address)' : form.bill_address!.trim(),
        phone: (form.phone ?? '').trim() === '' ? null : form.phone!.trim(),
        email: (form.email ?? '').trim() === '' ? null : form.email!.trim(),
        gstin: tax.account === 'gst' ? branch?.gstin ?? null : null,
        taxNumber: tax.account === 'gst' && branch?.gstin ? { label: 'GSTIN', value: branch.gstin }
          : takesNumber && tax.number.trim() !== '' ? { label: NUMBER_LABEL[tax.account], value: tax.number.trim().toUpperCase() }
            : null,
        footer: form.bill_footer.trim(),
      },
    };
    return [
      ...(layout.copies.customer ? [{ purpose: 'customer' as const, bill: doc }] : []),
      ...(layout.copies.kitchen ? [{ purpose: 'kitchen' as const, ticket: EXAMPLE_TICKET, parcel: true, reprint: false }] : []),
      ...(layout.copies.counter ? [{ purpose: 'counter' as const, bill: doc }] : []),
    ];
  }, [form, layout, props.restaurantName, branch?.gstin, tax, takesNumber, example]);

  const noCopy = form !== null && !form.bill_copy_customer && !form.bill_copy_kitchen && !form.bill_copy_counter;
  const chargeCheck = chargeColumns(charge);
  // The same rule as 0088's CHECK, so a refused heading is said here, not by the server.
  const headingProblems = form === null ? [] : HEADING_FIELDS.map((f) => headingProblem(form[f.key]));
  const headingsOk = headingProblems.every((problem) => problem === null);
  const headingsDefault = form !== null && HEADING_FIELDS.every((f) => form[f.key] === f.fallback);

  const save = async (): Promise<void> => {
    if (branch === null || form === null || noCopy || chargeCheck.columns === null || !headingsOk) return;
    setBusy(true); setRefusal(null); setDone(null);
    try {
      if (printer !== null && printerForm !== null) {
        await props.api.patchDetailed(`/admin/printers/${printer.id}`, { ...printerForm });
      }
      // Tax first: it is the save the server may refuse (an order is open), and
      // then nothing else on the page has moved either.
      if (taxChanged) {
        await props.api.postDetailed(`/admin/branches/${branch.id}/tax`, {
          taxEnabled: tax.enabled, taxAccountType: tax.account, taxCalculationMode: tax.mode,
          taxRegistrationNo: takesNumber && tax.number.trim() !== '' ? tax.number.trim() : null,
        });
      }
      await props.api.patchDetailed(`/admin/branches/${branch.id}`, {
        ...form,
        phone: (form.phone ?? '').trim() === '' ? null : form.phone!.trim(),
        email: (form.email ?? '').trim() === '' ? null : form.email!.trim(),
        bill_name: (form.bill_name ?? '').trim() === '' ? null : form.bill_name!.trim(),
        bill_address: (form.bill_address ?? '').trim() === '' ? null : form.bill_address!.trim(),
        bill_footer: form.bill_footer.trim(),
        bill_heading_unpaid: form.bill_heading_unpaid.trim(),
        bill_heading_part_paid: form.bill_heading_part_paid.trim(),
        bill_heading_paid: form.bill_heading_paid.trim(),
        ...chargeCheck.columns,
      });
      setDone(`Saved. Bills printed at ${branch.name} from now on use this.`);
      await read();
      await readPrinters(branch.id);
    } catch (error) {
      setRefusal(error instanceof Error ? error.message : 'That did not go through.');
    } finally { setBusy(false); }
  };

  // The same send the till uses: straight to a connected USB or Bluetooth printer, else the dialog.
  const testPrint = async (): Promise<void> => {
    if (pages.length === 0) return;
    setRefusal(null); setDone(null);
    const outcome = await sendCopies(pages, layout, { logoUrl: props.logoUrl ?? null });
    if (outcome.via === 'dialog') return;
    if (outcome.failed.length > 0) setRefusal(outcome.message ?? 'The printer did not take every copy.');
    else setDone(`Test page sent to the printer (${pages.length} ${pages.length === 1 ? 'copy' : 'copies'}). Check the paper: the printer cannot say whether it printed.`);
  };

  return (
    <div className="max-w-[1100px]">
      <h1 className="mb-1 text-2xl font-bold tracking-tight">Printed bill</h1>
      <p className="mb-5 text-[13px] leading-relaxed text-foreground/70 text-pretty">
        Which printer the bill is laid out for, what it shows, and which copies print once an order is paid.
        The items, tax and totals come from each bill itself.
      </p>

      {branches.state === 'unknown' && branches.reason === 'never-read' ? (
        <TableSkeleton label="branches" columns={2} rows={3} />
      ) : branches.state === 'unknown' ? (
        <Missing reason={branches.reason}>
          {branches.reason === 'not-permitted'
            ? 'You do not have permission to see the branches.'
            : 'The branches could not be read just now.'}
        </Missing>
      ) : branch === null || form === null ? (
        <p className="text-sm text-muted-foreground">There is no active branch yet.</p>
      ) : (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
          <div className="flex min-w-0 flex-col gap-5">
            {rows.length > 1 && (
              <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold">Branch</span>
                <select value={branch.id} onChange={(e) => { setBranchId(e.target.value); setDone(null); }}
                  className="h-9 rounded-md border border-border bg-card px-2 text-sm">
                  {rows.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
                </select>
              </label>
            )}

            <Section icon={<Printer aria-hidden className="size-4" />} title="Printer">
              <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold">Bill printer</span>
                <select value={form.bill_printer_id ?? ''} onChange={(e) => set('bill_printer_id', e.target.value === '' ? null : e.target.value)}
                  className="h-10 rounded-md border border-border bg-card px-2 text-sm">
                  <option value="">This computer&apos;s print dialog (3-inch roll)</option>
                  {printers.map((p) => (
                    <option key={p.id} value={p.id}>{p.name} · {CONNECTION[p.connection_kind] ?? p.connection_kind}</option>
                  ))}
                </select>
                <span className="text-xs text-muted-foreground">
                  {printers.length === 0 ? 'Add printers under Setup → Printers. ' : ''}{connectionNote(printer?.connection_kind ?? null)}
                </span>
              </label>
              {(printer?.connection_kind === 'usb' || printer?.connection_kind === 'bluetooth') && (
                <div className="rounded-md border border-border bg-background p-3">
                  <PrinterConnection connection={printer.connection_kind} />
                </div>
              )}

              {printer !== null && printerForm !== null && (
                <div className="grid gap-4 sm:grid-cols-2">
                  <Choice label="1. Printer type" value={printerForm.printer_type}
                    options={PRINTER_TYPES.filter((t) => printer.connection_kind !== 'network' || t.value === 'thermal')}
                    onChange={(v) => setPrinter('printer_type', v as PrinterType)}
                    hint={printer.connection_kind === 'network' ? 'A network printer is sent receipt-printer commands, so it is thermal.' : undefined} />
                  <Choice label="2. Paper size" value={printerForm.paper_size}
                    options={papersFor(printerForm.printer_type).map((size) => ({ value: size, label: PAPER[size].label }))}
                    onChange={(v) => setPrinter('paper_size', v as PaperSize)} />
                  {!PAPER[printerForm.paper_size].roll && (
                    <Choice label="Orientation" value={printerForm.orientation}
                      options={[{ value: 'portrait', label: 'Portrait' }, { value: 'landscape', label: 'Landscape' }]}
                      onChange={(v) => setPrinter('orientation', v as Orientation)} />
                  )}
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-semibold">Margins (mm)</span>
                    <Input type="number" min={0} max={20} value={printerForm.margin_mm}
                      onChange={(e) => setPrinter('margin_mm', Math.max(0, Math.min(20, Number(e.target.value) || 0)))} className="h-10" />
                  </label>
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-semibold">Font size (px)</span>
                    <Input type="number" min={9} max={18} value={printerForm.font_size_px}
                      onChange={(e) => setPrinter('font_size_px', Math.max(9, Math.min(18, Number(e.target.value) || 12)))} className="h-10" />
                  </label>
                </div>
              )}
            </Section>

            <Section icon={<Settings2 aria-hidden className="size-4" />} title="What the bill shows">
              <div className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
                <Toggle label="Logo" checked={form.bill_show_logo} onChange={(v) => set('bill_show_logo', v)} />
                <Toggle label="Address and phone" checked={form.bill_show_details} onChange={(v) => set('bill_show_details', v)} />
                <Toggle label="Customer name" checked={form.bill_show_customer} onChange={(v) => set('bill_show_customer', v)} />
                <Toggle label={tax.account === 'gst' ? 'Tax breakdown (CGST / SGST)' : 'Tax breakdown by rate'} checked={form.bill_show_tax}
                  onChange={(v) => set('bill_show_tax', v)}
                  hint={form.bill_show_tax ? undefined : `One ${TAX_WORD[tax.account]} line instead. A registered outlet should keep the breakdown.`} />
                <Toggle label="How it was paid" checked={form.bill_show_payments} onChange={(v) => set('bill_show_payments', v)} />
                <Toggle label="Copy name at the top (CUSTOMER / KITCHEN / COUNTER)" checked={form.bill_show_copy_label}
                  onChange={(v) => set('bill_show_copy_label', v)}
                  hint={form.bill_show_copy_label ? undefined : 'Hidden. A reprint still says REPRINT, and a parcel still says PARCEL.'} />
              </div>
            </Section>

            <Section icon={<Building2 aria-hidden className="size-4" />} title="Company details">
              <p className="m-0 text-xs text-muted-foreground">
                Printed at the top of the bill. Everything here is optional; only what is filled in is printed.
                The logo is the one set with your restaurant&apos;s branding.
              </p>
              <div className="grid gap-4 sm:grid-cols-2">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-semibold">Name on the bill</span>
                  <Input value={form.bill_name ?? ''} onChange={(e) => set('bill_name', e.target.value)} maxLength={120}
                    placeholder={props.restaurantName} />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-semibold">Phone number</span>
                  <Input value={form.phone ?? ''} onChange={(e) => set('phone', e.target.value)} maxLength={20}
                    placeholder="+91 98450 12345" inputMode="tel" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-semibold">Email</span>
                  <Input type="email" value={form.email ?? ''} onChange={(e) => set('email', e.target.value)} maxLength={254}
                    placeholder="hello@restaurant.com" inputMode="email" />
                </label>
                {tax.account === 'gst' ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-semibold">GSTIN</span>
                    <Input value={branch.gstin ?? ''} readOnly disabled placeholder="Not registered" />
                    <span className="text-xs text-muted-foreground">Set with the branch&apos;s GST registration.</span>
                  </label>
                ) : takesNumber ? (
                  <label className="flex flex-col gap-1">
                    <span className="text-xs font-semibold">{tax.account === 'vat' ? 'VAT registration number (TRN)' : 'Tax registration number'}</span>
                    <Input value={tax.number} onChange={(e) => setTaxField('number', e.target.value)} maxLength={30}
                      placeholder={tax.account === 'vat' ? '100123456700003' : 'Optional'} />
                  </label>
                ) : null}
              </div>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold">Address on the bill</span>
                <textarea value={form.bill_address ?? ''} onChange={(e) => set('bill_address', e.target.value)} maxLength={300} rows={2}
                  placeholder="Leave empty to print the restaurant's address"
                  className="rounded-md border border-border bg-card p-2 text-sm" />
              </label>
              <label className="flex flex-col gap-1">
                <span className="text-xs font-semibold">Message at the bottom</span>
                <Input value={form.bill_footer} onChange={(e) => set('bill_footer', e.target.value)} maxLength={200}
                  placeholder="Thank you! Visit again" />
              </label>
            </Section>

            <Section icon={<Heading aria-hidden className="size-4" />} title="Bill headings">
              <p className="m-0 text-xs text-muted-foreground">
                The title at the top of the customer and counter copies, by how much of the bill is paid. The kitchen
                ticket keeps its own. A reprint still adds COPY 2, COPY 3 and says REPRINT.
              </p>
              <datalist id="bill-heading-ideas">
                {HEADING_IDEAS.map((idea) => <option key={idea} value={idea} />)}
              </datalist>
              <div className="grid gap-4 sm:grid-cols-3">
                {HEADING_FIELDS.map((f, i) => (
                  <label key={f.key} className="flex flex-col gap-1">
                    <span className="text-xs font-semibold">{f.label}</span>
                    <Input value={form[f.key]} maxLength={HEADING_MAX} list="bill-heading-ideas" placeholder={f.fallback}
                      aria-invalid={headingProblems[i] !== null}
                      onFocus={() => setExample(f.state)}
                      onChange={(e) => { set(f.key, e.target.value); setExample(f.state); }} />
                    {headingProblems[i] !== null
                      ? <span role="alert" className="text-xs font-semibold text-destructive">{headingProblems[i]}</span>
                      : <span className="text-xs text-muted-foreground">{f.hint}</span>}
                  </label>
                ))}
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs text-muted-foreground">Fully paid as:</span>
                {PAID_IDEAS.map((idea) => (
                  <Button key={idea} type="button" size="sm" variant={form.bill_heading_paid.trim() === idea ? 'default' : 'outline'}
                    aria-pressed={form.bill_heading_paid.trim() === idea}
                    onClick={() => { set('bill_heading_paid', idea); setExample('paid'); }}>
                    {idea}
                  </Button>
                ))}
                <Button type="button" size="sm" variant="ghost" disabled={headingsDefault}
                  onClick={() => { for (const f of HEADING_FIELDS) set(f.key, f.fallback); }}>
                  Reset to default
                </Button>
              </div>
              <p className="m-0 text-xs text-muted-foreground">
                Up to {HEADING_MAX} characters: English letters, digits, spaces and common punctuation, which every
                receipt printer can print. Saved with the Save button below; bills printed or reprinted after that use it.
                {tax.enabled && tax.account === 'gst'
                  ? ' A GST-registered outlet’s bill is usually headed TAX INVOICE: confirm the wording with whoever files your GST returns.'
                  : ''}
              </p>
            </Section>

            <Section icon={<Percent aria-hidden className="size-4" />} title="Tax">
              <Toggle label="Tax enabled" checked={tax.enabled} onChange={(v) => setTaxField('enabled', v)}
                hint={tax.enabled ? undefined : 'Off: no tax is charged and none is printed.'} />
              <div className="grid gap-4 sm:grid-cols-2">
                <Choice label="Tax Calculation Mode in Sales" value={tax.mode}
                  options={[{ value: 'forward', label: 'FORWARD' }, { value: 'reverse', label: 'REVERSE' }]}
                  onChange={(v) => setTaxField('mode', v as TaxMode)}
                  hint={tax.mode === 'forward' ? 'Tax is added to the price: 100 + 5% = 105.' : 'Prices include tax: 100 holds 4.76 at 5%.'} />
                <Choice label="Tax Account Type" value={tax.account}
                  options={accounts.map((a) => ({ value: a, label: ACCOUNT_LABEL[a] }))}
                  onChange={(v) => setTaxField('account', v as TaxAccount)}
                  hint={tax.account === 'none' ? 'No tax is charged.' : 'Each dish is taxed at its own rate, set under Tax rates.'} />
              </div>
              <p className="m-0 text-xs text-muted-foreground">
                Applies to orders opened after saving, and cannot be changed while an order is open.
              </p>
            </Section>

            <Section icon={<Printer aria-hidden className="size-4" />} title="Copies and printing">
              <div className="grid gap-x-6 gap-y-3 sm:grid-cols-3">
                <Toggle label="Customer bill" checked={form.bill_copy_customer} onChange={(v) => set('bill_copy_customer', v)} />
                <Toggle label="Kitchen copy" checked={form.bill_copy_kitchen} onChange={(v) => set('bill_copy_kitchen', v)} />
                <Toggle label="Counter copy" checked={form.bill_copy_counter} onChange={(v) => set('bill_copy_counter', v)} />
              </div>
              {noCopy && <p role="alert" className="m-0 text-xs font-semibold text-destructive">Choose at least one copy.</p>}
              <Toggle label="Print automatically once an order is paid" checked={form.bill_auto_print}
                onChange={(v) => set('bill_auto_print', v)}
                hint={form.bill_auto_print ? 'The copies print straight away.' : 'The POS shows a preview with a Print button.'} />
            </Section>

            <Section icon={<ShoppingBag aria-hidden className="size-4" />} title="Parcel charge">
              <p className="m-0 text-xs text-muted-foreground">
                Added to a parcel bill for packing. The till fills in the usual charge and may change it, up to the most
                allowed. It is taxed with the food, at the rate chosen here. Leave the most at 0 to take no parcel charge.
              </p>
              <div className="grid gap-4 sm:grid-cols-3">
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-semibold">Usual charge</span>
                  <Input aria-label="Usual parcel charge" value={charge.defaultText} inputMode="decimal" placeholder="0.00"
                    onChange={(e) => { setCharge({ ...charge, defaultText: e.target.value }); setDone(null); }} className="h-10" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-semibold">Most it may charge</span>
                  <Input aria-label="Most parcel charge" value={charge.maxText} inputMode="decimal" placeholder="0.00"
                    onChange={(e) => { setCharge({ ...charge, maxText: e.target.value }); setDone(null); }} className="h-10" />
                </label>
                <label className="flex flex-col gap-1">
                  <span className="text-xs font-semibold">Tax rate</span>
                  <select aria-label="Parcel charge tax rate" value={charge.taxClassId ?? ''}
                    onChange={(e) => { setCharge({ ...charge, taxClassId: e.target.value === '' ? null : e.target.value }); setDone(null); }}
                    className="h-10 rounded-md border border-border bg-card px-2 text-sm">
                    <option value="">Choose a tax rate</option>
                    {taxClasses.map((t) => <option key={t.id} value={t.id}>{t.name} · {pctOfBps(t.rate_bps)}</option>)}
                  </select>
                </label>
              </div>
              {chargeCheck.problem !== null
                ? <p role="alert" className="m-0 text-xs font-semibold text-destructive">{chargeCheck.problem}</p>
                : chargeCheck.columns !== null && chargeCheck.columns.parcel_charge_max_minor > 0 && (
                  <p className="m-0 text-xs text-muted-foreground">
                    The till fills in {formatMinor(minorFrom(chargeCheck.columns.parcel_charge_default_minor))} and accepts
                    up to {formatMinor(minorFrom(chargeCheck.columns.parcel_charge_max_minor))}.
                  </p>
                )}
            </Section>

            {/* Beside the button that caused it, so a refused save is seen where it was clicked. */}
            {refusal !== null && <RefusalBanner>{refusal}</RefusalBanner>}
            {done !== null && <DoneBanner>{done}</DoneBanner>}
            <div className="flex flex-wrap gap-2">
              <Button type="button" disabled={busy || noCopy || chargeCheck.columns === null || !headingsOk} onClick={() => void save()}>
                {busy ? 'Saving…' : 'Save'}
              </Button>
              <Button type="button" variant="outline" disabled={pages.length === 0} onClick={() => void testPrint()}>
                Print a test page
              </Button>
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              Preview (example order)
            </span>
            <div role="radiogroup" aria-label="Example bill" className="flex gap-1 rounded-md border border-border bg-card p-1">
              {EXAMPLE_STATES.map((x) => (
                <button key={x.value} type="button" role="radio" aria-checked={example === x.value}
                  onClick={() => setExample(x.value)}
                  className={cn('grow rounded px-2 py-1 text-xs font-semibold',
                    example === x.value ? 'bg-foreground text-background' : 'text-muted-foreground')}>
                  {x.label}
                </button>
              ))}
            </div>
            {pages.length > 0
              ? <PrintPreview pages={pages} layout={layout} options={{ logoUrl: props.logoUrl ?? null }} maxWidth={350} />
              : <p className="text-sm text-muted-foreground">No copy is chosen.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function Section(props: { icon: ReactNode; title: string; children: ReactNode }): ReactElement {
  return (
    <Card className="gap-4 rounded-[4px] border-border p-5">
      <h2 className="m-0 flex items-center gap-2 text-sm font-bold">{props.icon}{props.title}</h2>
      {props.children}
    </Card>
  );
}

function Toggle(props: { label: string; checked: boolean; onChange: (value: boolean) => void; hint?: string | undefined }): ReactElement {
  return (
    <label className="flex cursor-pointer items-start gap-3">
      <Switch checked={props.checked} onCheckedChange={props.onChange} aria-label={props.label} className="mt-0.5" />
      <span className="flex flex-col">
        <span className="text-sm font-medium">{props.label}</span>
        {props.hint !== undefined && <span className="text-xs text-muted-foreground">{props.hint}</span>}
      </span>
    </label>
  );
}

function Choice(props: {
  label: string; value: string; options: readonly { value: string; label: string }[];
  onChange: (value: string) => void; hint?: string | undefined;
}): ReactElement {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs font-semibold">{props.label}</span>
      <select value={props.value} onChange={(e) => props.onChange(e.target.value)}
        className="h-10 rounded-md border border-border bg-card px-2 text-sm">
        {props.options.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
      </select>
      {props.hint !== undefined && <span className="text-xs text-muted-foreground">{props.hint}</span>}
    </label>
  );
}
