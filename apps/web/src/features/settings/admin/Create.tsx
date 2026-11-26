import { useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import { NotMinorUnitsError, formatMinor, minorFrom } from '../../../lib/money.js';
import {
  label, MONEY_COLUMNS, FIELD_CHOICES, CHOICE_HELP, CHOICE_HIDES, DERIVED_PREFIX,
} from '../../../app/admin/tokens.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import { cn } from '@/lib/utils.js';
import { RequiredMark } from '../../../components/admin/required-mark.js';

/**
 * Creating a row.
 *
 * ###########################################################################
 * THE FIELDS COME FROM `creatable`, AND THIS FILE HAS NO SECOND OPINION.
 *
 * `GET /admin/:resource` returns `creatable` beside the rows: the server's own
 * per-resource, per-OPERATION allowlist. This form renders exactly that array
 * and nothing else, for the same reason the table renders whatever columns come
 * back -- a client that also knows what may be created is a second declaration,
 * and it drifts in the direction nobody notices. The server would then refuse
 * the whole request naming a field the form insists on showing, and the manager
 * would have no way to get rid of it.
 *
 * Three consequences, all of them deliberate:
 *
 *   - `creatable` is EMPTY for stations, printers and terminals. They get no
 *     create control at all -- not a disabled one, not an empty form. A form
 *     that cannot submit is a promise the route does not keep. (Terminals are
 *     enrolled, which mints a one-time token; stations and printers have no
 *     create route at all.)
 *   - `editable` and `creatable` are different arrays and this form uses only
 *     the second. `menu/items` may be created with a `key` and can never have it
 *     changed afterwards, which is exactly right and is not this file's business.
 *   - the ID IS NEVER SENT. It is minted server-side, because a caller-supplied
 *     primary key is a way to probe for rows that exist and a way to collide
 *     with a write another tenant is about to make.
 * ###########################################################################
 *
 * ###########################################################################
 * A BLANK FIELD IS NOT SENT, AND THE SERVER SAYS WHAT IS REQUIRED.
 *
 * `required` in the list response is derived by the server from the table's
 * own NOT NULLs, so this form marks those fields and holds the Create button
 * until they are filled -- without keeping a copy of the rule. A field left
 * blank is still omitted from the body, and anything the list could not know
 * the server still refuses as `field_required` (SQLSTATE 23502), naming it.
 *
 * The alternative -- sending `''` for every untouched field -- is worse in a way
 * that survives: an empty string satisfies NOT NULL. A branch called `''`, or a
 * menu item with an empty name, is created successfully and has to be found by
 * eye afterwards.
 * ###########################################################################
 */

/** The server sets these from the token; a value typed here would be discarded. */
const FROM_THE_TOKEN: readonly string[] = ['branch_id'];

export function CreateRow(props: {
  title: string;
  /** The server's `creatable`. Never a copy, never a superset. */
  fields: readonly string[];
  /** The server's `required`: derived from the table's NOT NULLs. */
  required: readonly string[];
  /** The rows already on screen, used only as a source of example values. */
  rows: readonly Record<string, unknown>[];
  busy: boolean;
  onCancel: () => void;
  onCreate: (values: Record<string, string>) => void;
}): ReactElement {
  const [draft, setDraft] = useState<Record<string, string>>({});

  /**
   * The fields actually offered.
   *
   * `id` and the branch column are dropped rather than shown disabled. The
   * branch one matters: `createHandler` applies `values[branchColumn] =
   * branchOnToken(request)` AFTER the allowlist check, so a branch typed here
   * would be silently overwritten -- the one outcome worse than refusing it.
   */
  const offered = useMemo(
    () => props.fields.filter(
      (field) => field !== 'id' && !FROM_THE_TOKEN.includes(field)),
    [props.fields],
  );

  /*
    Fields the answers have made inapplicable, and fields taken from another
    field. Both mirror a schema constraint rather than inventing a rule -- see
    CHOICE_HIDES and DERIVED_PREFIX -- and both are computed from the draft, so
    a changed answer puts a hidden field back.
  */
  const hidden = new Set<string>();
  for (const field of offered) {
    const chosen = (draft[field] ?? '').trim();
    if (chosen === '') continue;
    for (const gone of CHOICE_HIDES[`${field}.${chosen}`] ?? []) hidden.add(gone);
  }
  for (const [field, source] of Object.entries(DERIVED_PREFIX)) {
    if (offered.includes(field) && offered.includes(source.from)) hidden.add(field);
  }
  const asked = offered.filter((field) => !hidden.has(field));

  const values: Record<string, string> = {};
  for (const field of asked) {
    const text = (draft[field] ?? '').trim();
    if (text.length > 0) values[field] = text;
  }
  // Derived fields are SENT but not asked. `state_code` is the GSTIN's first two
  // digits; a blank one would be refused by branch_gstin_matches_state on a
  // registered branch, and a hidden one on an unregistered branch is correctly
  // absent because its source is too.
  for (const [field, source] of Object.entries(DERIVED_PREFIX)) {
    const from = values[source.from];
    if (from !== undefined && from.length >= source.length) {
      values[field] = from.slice(0, source.length);
    }
  }
  const filled = Object.keys(values).length;

  /*
    The ONE requiredness this form knows, and it knows it from its own
    rendering rather than from a guess about the schema.

    A choice field offers no blank option, so a blank one has not been answered
    -- there is no value it could be standing in for. Everything else stays as
    it was: blank is omitted, and the server names what it needs. Submitting
    with the GST question unanswered would otherwise mean a round trip to be
    told `field_required` about the one field on the form the owner cannot
    guess the answer to.
  */
  const unanswered = asked.filter(
    (field) => FIELD_CHOICES[field] !== undefined && (draft[field] ?? '').trim() === '');
  const missing = asked.filter(
    (field) => props.required.includes(field) && FIELD_CHOICES[field] === undefined && values[field] === undefined);
  const ready = filled > 0 && unanswered.length === 0 && missing.length === 0;

  return (
    <div className="flex flex-col gap-3.5">
      <span className="text-[13px] leading-relaxed text-muted-foreground text-pretty">
        Fields marked <RequiredMark /> must be filled. A field left blank is not
        sent. Anything a new row needs beyond these fields — a credential, a
        role, a status — has its own screen and its own permission.
      </span>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(240px,100%),1fr))] gap-3">
        {asked.map((field) => (
          <FieldInput
            key={field}
            field={field}
            required={props.required.includes(field) || FIELD_CHOICES[field] !== undefined}
            value={draft[field] ?? ''}
            rows={props.rows}
            onChange={(next) => setDraft((current) => ({ ...current, [field]: next }))}
          />
        ))}
      </div>

      <div className="flex items-center gap-2.5">
        <Button
          type="button"
          onClick={() => props.onCreate(values)}
          disabled={props.busy || !ready}
          className={cn(
            'h-11 px-5 text-[15px] font-bold',
            ready && !props.busy
              ? 'bg-brand-gradient text-primary-foreground hover:opacity-90'
              : 'bg-[#DCDCDC] text-muted-foreground',
          )}
        >
          {props.busy ? 'Creating…'
            : filled === 0 ? 'Nothing filled in yet'
              : unanswered.length > 0
                ? `Answer ${unanswered.map((f) => label(f)).join(' and ')} first`
                : missing.length > 0
                  ? `Fill in ${missing.map((f) => label(f)).join(', ')} first`
                  : `Create with ${filled} field${filled === 1 ? '' : 's'}`}
        </Button>
        <Button type="button" variant="outline" onClick={props.onCancel} disabled={props.busy}
          className="h-11 border-[1.5px] border-foreground px-[18px] text-[15px] font-semibold">
          Cancel
        </Button>
        {/* No destructive control on a create form, deliberately: the only
            confirm-shaped thing here is Create, and a row that does not exist
            yet has nothing to take out of use. */}
      </div>
    </div>
  );
}

/**
 * One field.
 *
 * ###########################################################################
 * THE EXAMPLE VALUES COME FROM THE ROWS THE SERVER JUST SENT.
 *
 * Several creatable fields are foreign keys or vocabularies with no route that
 * lists them: `menu/items` takes `category_id` and a NOT NULL `tax_class_id`,
 * and nothing in the API returns menu categories or tax classes. Left to itself
 * this form would ask a manager to type two uuids they have no way to look up.
 *
 * They are, however, in the rows on the screen. So the values already in use in
 * this list are offered as one-tap fills. That is not a second declaration --
 * it is the server's own data, echoed back -- and it is labelled as what it is:
 * values already in use, not a list of the options.
 * ###########################################################################
 */
function FieldInput(props: {
  field: string;
  required: boolean;
  value: string;
  rows: readonly Record<string, unknown>[];
  onChange: (next: string) => void;
}): ReactElement {
  const { field } = props;
  const money = MONEY_COLUMNS.includes(field);
  const choices = FIELD_CHOICES[field];

  const inUse = useMemo(() => {
    const seen: string[] = [];
    for (const row of props.rows) {
      const value = row[field];
      if (value === null || value === undefined) continue;
      const text = String(value);
      if (text.length === 0 || seen.includes(text)) continue;
      seen.push(text);
      if (seen.length === 6) break;
    }
    return seen;
  }, [props.rows, field]);

  /*
    ###########################################################################
    A FIXED VOCABULARY IS ASKED, NOT TYPED.

    `gst_registration` is NOT NULL with no default, so the form's ordinary
    behaviour -- omit a blank field and let the server name what it needs --
    already makes this question unskippable. It does not make it ANSWERABLE: a
    free-text box asking an owner to type `unregistered` is a spelling test with
    a tax consequence, and `branch_gst_registration_known` would refuse
    'Unregistered' with a constraint name.

    So it is two buttons, with NO PRESELECTION. A default here would be the
    thing this whole change exists to remove: something other than the owner
    deciding whether their restaurant charges GST.
    ###########################################################################
  */
  if (choices !== undefined) {
    const chosen = props.value;
    return (
      <div className="flex flex-col gap-1.5">
        <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {label(field)}{props.required && <RequiredMark />}
        </Label>
        <div className="flex flex-wrap gap-2">
          {choices.map((choice) => {
            const on = chosen === choice;
            return (
              <Button key={choice} type="button" variant={on ? 'default' : 'outline'}
                onClick={() => props.onChange(on ? '' : choice)}
                className={cn(
                  'h-10 px-4 text-sm',
                  on
                    ? 'bg-brand-gradient text-primary-foreground font-bold hover:opacity-90'
                    : 'border-[1.5px] border-foreground font-semibold text-foreground',
                )}>
                {label(choice)}
              </Button>
            );
          })}
        </div>
        <span className={cn(
          'text-[11px] leading-relaxed text-pretty',
          chosen === '' ? 'font-semibold text-destructive' : 'text-muted-foreground',
        )}>
          {chosen === ''
            ? 'Not answered. A branch cannot be opened until this is decided — it '
              + 'determines whether every diner here is charged GST.'
            : CHOICE_HELP[`${field}.${chosen}`] ?? ''}
        </span>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-1.5">
      <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        {label(field)}{money && ' (minor units)'}{props.required && <RequiredMark />}
      </Label>
      <Input
        value={props.value}
        onChange={(event) => props.onChange(event.target.value)}
        className={cn('h-10 text-sm', (money || field.endsWith('_id')) && 'font-mono')}
      />

      {/*
        Money is typed in MINOR UNITS and shown back formatted, with no
        arithmetic anywhere between.

        A major-unit field would need a client-side multiply, and `250.55 * 100`
        is 25054.999999999996 -- a rounding bug in the one place the codebase
        refuses to have one. `minorFrom` accepts an integer and nothing else, so
        what the manager sees below the field is exactly what will be stored.
      */}
      {money && <MoneyEcho text={props.value} />}

      {inUse.length > 0 && (
        <div className="flex flex-wrap items-baseline gap-1.5">
          <span className="text-[11px] text-muted-foreground">in use:</span>
          {inUse.map((value) => (
            <button key={value} type="button" onClick={() => props.onChange(value)}
              className={cn(
                'max-w-full overflow-hidden text-ellipsis whitespace-nowrap rounded-[4px]',
                'border border-border bg-background px-1.5 py-0.5 text-[11px] text-muted-foreground',
                (field.endsWith('_id') || money) && 'font-mono',
              )}>
              {value}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * What the typed number MEANS, echoed under the field.
 *
 * ###########################################################################
 * `minorFrom('250.00')` IS 250, NOT 25000, AND IT DOES NOT THROW.
 *
 * It parses a string with `Number.parseInt`, which truncates at the decimal
 * point and returns a perfectly good integer. So a manager typing a price the
 * way a price is written -- 250.00 -- would create an item costing two rupees
 * fifty, with no error anywhere: the value is an integer, the column is happy,
 * and the mistake is a factor of a hundred.
 *
 * So the SHAPE is checked here, before `minorFrom` gets a chance to be helpful,
 * and the amount is echoed back formatted either way. The echo is the real
 * safeguard: 25000 reading back as ₹250.00 is a fact a manager can check, and it
 * does not depend on them knowing what a minor unit is.
 * ###########################################################################
 */
function MoneyEcho(props: { text: string }): ReactElement {
  const trimmed = props.text.trim();
  if (trimmed.length === 0) {
    return (
      <span className="text-[11px] text-muted-foreground">
        whole minor units — 25000 is {formatMinor(minorFrom(25_000))}
      </span>
    );
  }
  if (!/^\d+$/.test(trimmed)) {
    return (
      <span className="text-[11px] font-semibold leading-snug text-destructive">
        minor units are whole and have no separator: 25000, not 250.00 — and
        250.00 would be read as {formatMinor(minorFrom(250))}.
      </span>
    );
  }
  try {
    return (
      <span className="font-mono text-xs text-foreground">
        {formatMinor(minorFrom(trimmed))}
      </span>
    );
  } catch (error) {
    // Named rather than swallowed: a fractional amount means somebody has
    // already done arithmetic on it, which is what `Minor` exists to catch.
    return (
      <span className="text-[11px] font-semibold text-destructive">
        {error instanceof NotMinorUnitsError
          ? 'not a number of minor units'
          : 'that amount could not be read'}
      </span>
    );
  }
}
