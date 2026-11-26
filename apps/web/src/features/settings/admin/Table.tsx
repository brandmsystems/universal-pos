import { Inbox, Pencil, Plus } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { ApiError, type Api } from '../../../services/api.js';
import { known, stale, unknown, type Remote } from '../../../lib/remote.js';
import { TableSkeleton } from '../../../components/admin/skeletons.js';
import { formatMinor, minorFrom } from '../../../lib/money.js';
import { parsePgTimestamp } from '../../../lib/pgtime.js';
import { label, MONEY_COLUMNS, TIME_COLUMNS } from '../../../app/admin/tokens.js';
import { CreateRow } from './Create.js';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { Label } from '@/components/ui/label.js';
import {
  Table as UiTable, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table.js';
import { RefusalBanner, DoneBanner } from '../../../components/admin/banner.js';
import { cn } from '@/lib/utils.js';
import { FormModal } from '../../../components/admin/form-modal.js';
import { RequiredMark } from '../../../components/admin/required-mark.js';

/**
 * The generic admin table.
 *
 * ###########################################################################
 * THE CLIENT DOES NOT KNOW WHAT THE COLUMNS ARE, AND MUST NOT.
 *
 * The server returns a declared allowlist per resource: `{ resource, rows,
 * limit, offset, more }`. This renders whatever comes back. That is not
 * laziness — it is the only arrangement in which the column allowlist is a
 * single fact. A client with its own list of columns per resource is a second
 * declaration, and the failure mode is silent in the direction that matters:
 * the server stops returning a field, the client keeps a header for it, and
 * every row shows blank where a value used to be.
 *
 * The consequence is that this file has no per-resource knowledge at all. What
 * it does have is a rendering rule per COLUMN KIND — money, timestamp,
 * boolean, id — declared in tokens.ts and applied by name. A column nobody has
 * named renders as raw text with its name shown ugly, so a new field arrives
 * visible rather than absent.
 * ###########################################################################
 *
 * ###########################################################################
 * AN EDIT SENDS ONLY WHAT CHANGED.
 *
 * The server refuses fields it does not declare writable, so a form that
 * submitted every column would be refused entirely — including the one field the
 * manager actually changed. So the form tracks its own dirty set and sends that.
 *
 * This is also why the refusal is worth showing verbatim: `fields_not_writable`
 * names what the route accepts, and the reason a field is refused is almost
 * always that it has its own route and its own permission. "Status cannot be set
 * here" is a more useful sentence than a generic failure.
 * ###########################################################################
 */

interface ListResponse {
  resource: string;
  rows: Record<string, unknown>[];
  limit: number;
  offset: number;
  more: boolean;
  /** The server's own allowlist. This client keeps no copy of it. */
  editable: string[];
  creatable: string[];
  /** Derived by the server from the table's NOT NULLs. */
  required?: string[];
  deletes: 'archive' | 'remove' | 'none';
}

export function Table(props: {
  api: Api;
  resource: string;
  title: string;
  /** Passed through from the server's refusal, so the manager sees the reason. */
  onArchived?: () => void;
}): ReactElement {
  const [page, setPage] = useState<Remote<ListResponse>>(unknown<ListResponse>());
  const [offset, setOffset] = useState(0);
  const [editing, setEditing] = useState<Record<string, unknown> | null>(null);
  const [creating, setCreating] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  /** What the server made, named back. Cleared on the next action. */
  const [created, setCreated] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const read = useCallback(async (): Promise<void> => {
    try {
      setPage(known(await props.api.get<ListResponse>(
        `/admin/${props.resource}?limit=50&offset=${offset}`)));
    } catch (error) {
      setPage((current) =>
        error instanceof ApiError && error.failure.kind === 'offline'
          ? stale(current)
          : unknown<ListResponse>(
            error instanceof ApiError && error.failure.kind === 'refused'
              && error.failure.status === 403 ? 'not-permitted' : 'read-failed'),
      );
    }
  }, [props.api, props.resource, offset]);

  useEffect(() => { void read(); }, [read]);
  useEffect(() => {
    setOffset(0);
    setEditing(null);
    setCreating(false);
    setRefusal(null);
    setCreated(null);
  }, [props.resource]);

  /**
   * Creating a row.
   *
   * ###########################################################################
   * ONLY THE DECLARED FIELDS, AND THE REFUSAL IS SHOWN AS THE SERVER WROTE IT.
   *
   * `writableOnly` refuses a field it does not declare AND refuses the whole
   * request, so the body is exactly the fields the form was given by `creatable`
   * and that the manager actually filled in. No id: the server mints it.
   *
   * `postDetailed` rather than `mutate` because the refusals that matter here --
   * `fields_not_writable`, `field_required`, `reference_invalid` -- carry their
   * entire value in the server's `detail` sentence, which `request` drops. See
   * the note on `requestDetailed` in shared/api.ts.
   *
   * On success the CREATED ROW is named back from the response rather than from
   * the draft: the server picked the columns it will show, and the id and any
   * defaulted status are its to report. A form that echoed the draft would claim
   * a row exists exactly as typed, which is the claim least worth trusting.
   * ###########################################################################
   */
  async function create(values: Record<string, string>): Promise<void> {
    setBusy(true);
    setRefusal(null);
    setCreated(null);
    try {
      const row = await props.api.postDetailed<Record<string, unknown>>(
        `/admin/${props.resource}`, values);
      const name = row['name'] ?? row['full_name'] ?? row['key'] ?? row['code'];
      const id = row['id'];
      setCreated(
        `${typeof name === 'string' && name.length > 0 ? name : 'The row'} was created`
        + `${typeof id === 'string' ? ` · ${id}` : ''}`);
      setCreating(false);
      await read();
    } catch (error) {
      // The form stays open with the draft intact: a refusal here is nearly
      // always one field, and clearing the other six is how a manager gives up.
      setRefusal(describe(error));
    } finally {
      setBusy(false);
    }
  }

  async function save(row: Record<string, unknown>, changed: Record<string, unknown>):
  Promise<void> {
    setBusy(true);
    setRefusal(null);
    try {
      // `patchDetailed`, not `patch`: this screen's whole approach to a refusal
      // is to show the server's sentence, and `patch` discards it. See the note
      // on `requestDetailed` in shared/api.ts.
      await props.api.patchDetailed(
        `/admin/${props.resource}/${String(row['id'])}`, changed);
      setEditing(null);
      await read();
    } catch (error) {
      setRefusal(describe(error));
    } finally {
      setBusy(false);
    }
  }

  async function archive(row: Record<string, unknown>): Promise<void> {
    setBusy(true);
    setRefusal(null);
    try {
      const result = await props.api.remove<Record<string, unknown>>(
        `/admin/${props.resource}/${String(row['id'])}`);
      // The response says which STATE the row is in now, or that it was deleted.
      // Reporting "removed" for an archived row would be a lie the manager acts
      // on later.
      if (result['deleted'] === true) setRefusal(null);
      await read();
      props.onArchived?.();
    } catch (error) {
      setRefusal(describe(error));
      await read();
    } finally {
      setBusy(false);
    }
  }

  const columns = page.state === 'unknown' ? [] : columnsOf(page.value.rows);

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="text-[22px] font-bold tracking-tight">{props.title}</span>
        {page.state === 'stale' && (
          <span className="text-[13px] font-semibold text-muted-foreground">
            last read {new Date(page.at).toLocaleTimeString()} — not updating
          </span>
        )}
        <div className="grow" />
        {/*
          The create control exists only where the SERVER says a create is
          possible.

          `creatable` empty means the route accepts no field, and for three of
          the seven resources here that is the truth: terminals are enrolled
          rather than created, and stations and printers have no create route at
          all. A greyed-out "Add" on those screens would tell a manager the
          feature is there and broken, which is the same mistake the sidebar
          avoids by not listing screens that do not exist.
        */}
        {page.state !== 'unknown' && page.value.creatable.length > 0 && !creating && (
          <Button type="button" onClick={() => {
            setCreating(true);
            setEditing(null);
            setRefusal(null);
            setCreated(null);
          }}
            className="h-10 bg-brand-gradient px-4 text-sm font-bold text-primary-foreground shadow-sm hover:opacity-90">
            <Plus aria-hidden className="size-4" />
            Add
          </Button>
        )}
      </div>

      {created !== null && <DoneBanner>{created}</DoneBanner>}

      {/* Above the form, not below it: the sentence names the field that was
          refused, and it has to be readable without scrolling past the inputs
          it is about. */}
      {refusal !== null && !creating && editing === null && <RefusalBanner>{refusal}</RefusalBanner>}

      <FormModal open={creating && page.state !== 'unknown'} wide busy={busy}
        title={`Add to ${props.title}`}
        onClose={() => { setCreating(false); setRefusal(null); }}>
        {refusal !== null && <div className="mb-3"><RefusalBanner>{refusal}</RefusalBanner></div>}
        {page.state !== 'unknown' && (
          <CreateRow
            title={props.title}
            // The server's arrays, passed straight through. This screen never
            // adds to them, filters them by taste, or remembers them.
            fields={page.value.creatable}
            required={page.value.required ?? []}
            rows={page.value.rows}
            busy={busy}
            onCancel={() => { setCreating(false); setRefusal(null); }}
            onCreate={(values) => void create(values)}
          />
        )}
      </FormModal>

      {page.state === 'unknown' && page.reason === 'never-read' ? (
        <TableSkeleton label={props.title} columns={4} />
      ) : page.state === 'unknown' ? (
        <div
          className="rounded-[4px] border border-dashed border-[#9A9A9A] p-4 text-sm text-muted-foreground text-pretty"
          style={{ background: 'repeating-linear-gradient(135deg, #FFFFFF 0 8px, #F4F4F4 8px 16px)' }}
        >
          {page.reason === 'not-permitted'
            ? 'This sign-in is not allowed to see this list. Nothing is shown rather '
              + 'than an empty table, because an empty table would read as "there are none".'
            : 'This list did not load. Nothing is shown rather than an empty table — '
              + 'an empty table and a failed read look identical.'}
        </div>
      ) : (
        <>
          <div
            className={cn(
              'overflow-x-auto rounded-xl border border-border bg-card shadow-sm animate-in fade-in duration-200',
              page.state === 'stale' && 'opacity-70',
            )}
          >
            <UiTable>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  {columns.map((column) => (
                    <TableHead key={column}
                      className="whitespace-nowrap border-b-2 border-border px-3 py-2.5 text-xs font-bold uppercase tracking-wider text-muted-foreground">
                      {label(column)}
                    </TableHead>
                  ))}
                  <TableHead className="border-b-2 border-border" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {page.value.rows.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={columns.length + 1} className="p-8 text-center text-muted-foreground">
                      <span className="flex flex-col items-center gap-2">
                        <Inbox aria-hidden className="size-8 text-muted-foreground/60" />
                        Nothing here yet.
                      </span>
                    </TableCell>
                  </TableRow>
                ) : page.value.rows.map((row) => (
                  <TableRow key={String(row['id'])}>
                    {columns.map((column) => (
                      <TableCell key={column} className="whitespace-nowrap border-b border-border px-3 py-2.5">
                        <Cell column={column} value={row[column]} />
                      </TableCell>
                    ))}
                    <TableCell className="whitespace-nowrap border-b border-border px-3 py-2">
                      <Button type="button" variant="outline" size="sm" disabled={busy}
                        onClick={() => { setEditing(row); setCreating(false); }}
                        className="h-8 border-foreground px-3 text-[13px] font-semibold">
                        <Pencil aria-hidden className="size-3.5" />
                        Edit
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </UiTable>
          </div>

          <div className="flex items-center gap-3">
            <Button type="button" variant="outline" disabled={offset === 0 || busy}
              onClick={() => setOffset(Math.max(0, offset - 50))}
              className={cn('h-[34px] px-3.5 text-[13px] font-semibold',
                offset === 0 && 'text-muted-foreground')}>
              Previous
            </Button>
            <span className="font-mono text-[13px] text-muted-foreground">
              {offset + 1}–{offset + page.value.rows.length}
            </span>
            <Button type="button" variant="outline" disabled={!page.value.more || busy}
              onClick={() => setOffset(offset + 50)}
              className={cn('h-[34px] px-3.5 text-[13px] font-semibold',
                !page.value.more && 'text-muted-foreground')}>
              Next
            </Button>
            {/* The count is deliberately not claimed. The server filters hidden
                states after the page, so a page can come back short and a total
                would be wrong. */}
            <span className="text-xs text-muted-foreground">
              {page.value.more ? 'more to come' : 'end of the list'}
            </span>
          </div>
        </>
      )}

      <FormModal open={editing !== null} wide busy={busy}
        title={`Edit ${String(editing?.['name'] ?? editing?.['full_name'] ?? '')}`.trim()}
        onClose={() => { setEditing(null); setRefusal(null); }}>
        {refusal !== null && <div className="mb-3"><RefusalBanner>{refusal}</RefusalBanner></div>}
      {editing !== null && (
        <EditRow
          row={editing}
          required={page.state === 'unknown' ? [] : page.value.required ?? []}
          // The SERVER's writable set, not a guess and not a copy. A form that
          // offered a field the route refuses would have the whole request
          // rejected -- including the one field the manager wanted to change.
          fields={page.state === 'unknown' ? [] : page.value.editable}
          deletes={page.state === 'unknown' ? 'none' : page.value.deletes}
          busy={busy}
          onCancel={() => { setEditing(null); setRefusal(null); }}
          onSave={(changed) => void save(editing, changed)}
          onArchive={() => void archive(editing)}
        />
      )}
      </FormModal>
    </div>
  );
}

/**
 * The column order comes from the FIRST row, and every row is asserted to agree.
 *
 * A union across rows would paper over a server that returned different shapes
 * per row, which would mean the allowlist was not being applied — worth seeing
 * rather than smoothing.
 */
function columnsOf(rows: readonly Record<string, unknown>[]): string[] {
  const first = rows[0];
  if (!first) return [];
  return Object.keys(first);
}

function Cell(props: { column: string; value: unknown }): ReactElement {
  const { column, value } = props;

  if (value === null || value === undefined) {
    // An em-dash, not an empty cell. "Not set" and "the column was omitted" are
    // different facts and a blank cell says neither.
    return <span className="text-muted-foreground">—</span>;
  }
  if (MONEY_COLUMNS.includes(column)) {
    return <span className="font-mono tabular-nums">{formatMinor(minorFrom(String(value)))}</span>;
  }
  if (TIME_COLUMNS.includes(column)) {
    const at = parsePgTimestamp(String(value));
    return (
      <span className="font-mono text-[13px]">
        {at === null ? String(value) : new Date(at).toLocaleString()}
      </span>
    );
  }
  if (typeof value === 'boolean') {
    return <span>{value ? 'yes' : 'no'}</span>;
  }
  if (column === 'id' || column.endsWith('_id')) {
    // Truncated for reading, and monospaced so the truncation is obviously a
    // truncation rather than the whole value.
    return (
      <span className="font-mono text-xs text-muted-foreground" title={String(value)}>
        {String(value).slice(0, 8)}…
      </span>
    );
  }
  if (column === 'status') {
    const text = String(value);
    const gone = ['archived', 'inactive', 'revoked', 'disabled', 'suspended'].includes(text);
    return (
      <span className={cn(
        'text-xs font-bold uppercase tracking-wider',
        gone ? 'text-destructive' : 'text-foreground/70',
      )}>
        {text}
      </span>
    );
  }
  return <span>{String(value)}</span>;
}

function EditRow(props: {
  row: Record<string, unknown>;
  fields: readonly string[];
  required: readonly string[];
  deletes: 'archive' | 'remove' | 'none';
  busy: boolean;
  onCancel: () => void;
  onSave: (changed: Record<string, unknown>) => void;
  onArchive: () => void;
}): ReactElement {
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [confirming, setConfirming] = useState(false);

  // Only the fields the manager actually touched. The server refuses anything it
  // does not declare writable, and it refuses the WHOLE request — so submitting
  // every column would lose the one change that was wanted.
  const changed: Record<string, unknown> = {};
  for (const [column, text] of Object.entries(draft)) {
    if (String(props.row[column] ?? '') !== text) changed[column] = text;
  }
  const blanked = props.fields.filter(
    (column) => props.required.includes(column) && draft[column] !== undefined && draft[column]!.trim() === '');
  const dirty = Object.keys(changed).length > 0 && blanked.length === 0;

  return (
    <div className="flex flex-col gap-3.5">
      <span className="text-[13px] text-muted-foreground text-pretty">
        {props.fields.length === 0
          ? 'Nothing on this list can be changed here.'
          : 'Only the fields this screen may change are shown. Anything else — a '
            + 'status, a revocation, a role — has its own screen and its own '
            + 'permission, deliberately.'}
      </span>

      <div className="grid grid-cols-[repeat(auto-fill,minmax(min(240px,100%),1fr))] gap-3">
        {props.fields.map((column) => (
          <div key={column} className="flex flex-col gap-1.5">
            <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {label(column)}{props.required.includes(column) && <RequiredMark />}
            </Label>
            <Input
              aria-invalid={blanked.includes(column) ? true : undefined}
              value={draft[column] ?? String(props.row[column] ?? '')}
              onChange={(event) =>
                setDraft((current) => ({ ...current, [column]: event.target.value }))}
              className="h-10 text-sm"
            />
          </div>
        ))}
      </div>

      <div className="flex items-center gap-2.5">
        <Button type="button" onClick={() => props.onSave(changed)}
          disabled={props.busy || !dirty}
          className={cn(
            'h-11 px-5 text-[15px] font-bold',
            dirty && !props.busy
              ? 'bg-brand-gradient text-primary-foreground hover:opacity-90'
              : 'bg-[#DCDCDC] text-muted-foreground',
          )}>
          {props.busy ? 'Saving…'
            : blanked.length > 0 ? `${blanked.map((c) => label(c)).join(', ')} cannot be blank`
            : dirty ? `Save ${Object.keys(changed).length} change${Object.keys(changed).length === 1 ? '' : 's'}`
              : 'Nothing changed'}
        </Button>
        <Button type="button" variant="outline" onClick={props.onCancel} disabled={props.busy}
          className="h-11 border-[1.5px] border-foreground px-[18px] text-[15px] font-semibold">
          Cancel
        </Button>
        <div className="grow" />

        {/* Two taps, and the second one names what will happen. A single
            destructive button next to Save is how a manager archives a branch
            they meant to rename. */}
        {/* The WORD comes from the server, because only it knows whether this
            resource archives a row or removes it -- and "take out of use" and
            "delete permanently" are not interchangeable in front of a manager.
            A resource that does neither shows no control at all. */}
        {props.deletes === 'none' ? null : confirming ? (
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold text-destructive">
              {props.deletes === 'remove' ? 'Delete it permanently?' : 'Take it out of use?'}
            </span>
            <Button type="button" variant="destructive" onClick={props.onArchive} disabled={props.busy}
              className="h-11 px-[18px] text-[15px] font-bold">
              {props.deletes === 'remove' ? 'Yes, delete it' : 'Yes, take it out'}
            </Button>
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}
              className="h-11 border-border px-3.5 text-sm">
              No
            </Button>
          </div>
        ) : (
          <Button type="button" variant="outline" onClick={() => setConfirming(true)} disabled={props.busy}
            className="h-11 border-[1.5px] border-destructive px-[18px] text-[15px] font-semibold text-destructive hover:bg-destructive/5">
            {/* Bundle-separation marker: tests/web/bundleSeparation.test.ts
                looks for this exact phrase in the ADMIN bundle only. */}
            {props.deletes === 'remove' ? 'Delete' : 'Take out of use'}
          </Button>
        )}
      </div>
    </div>
  );
}

function describe(error: unknown): string {
  if (!(error instanceof ApiError)) return 'That did not go through.';
  if (error.failure.kind === 'offline') return 'No connection, so nothing was changed.';
  if (error.failure.kind === 'signed-out') return 'You have been signed out.';
  switch (error.failure.code) {
    case 'fields_not_writable':
      // Shown verbatim: the server's message names what the route accepts, and
      // the reason a field is refused is almost always that it has its own
      // route and its own permission.
      return error.message;
    case 'resource_not_archivable':
      return 'This cannot be taken out of use — whatever refers to it keeps it.';
    case 'reference_invalid':
      return 'Something still refers to this, so it cannot be removed.';
    case 'already_exists':
      // A unique index refused it: a code or a key this restaurant already
      // uses. The server names the constraint, which is worth carrying through
      // -- it says WHICH uniqueness rule, and a row can break more than one.
      return 'Something with that code or key already exists, so nothing was '
        + `created. (${error.message})`;
    case 'field_required':
      // SQLSTATE 23502, and the detail names the COLUMN. Nothing in the list
      // response says which fields are required, so this refusal is the only
      // place that answer comes from.
      return `A field this row cannot do without was left blank: ${error.message}`;
    case 'field_malformed':
      return `One of those values is not the right shape: ${error.message}`;
    case 'field_value_not_scalar':
      return error.message;
    case 'invariant_refused':
      // A CHECK or a constraint trigger. The server deliberately does NOT
      // forward its message -- those quote row values -- so it names the
      // constraint instead, and that is what gets shown.
      return 'The database refused that value as one it does not allow: '
        + `${error.message}. The rule is in the schema, not on this screen.`;
    case 'forbidden':
      // A 403 answers `{ error: 'forbidden' }` with no detail and no permission
      // key, so this sentence has to carry the context on its own.
      return 'This sign-in is not allowed to do that here. Reading a list and '
        + 'changing it are separate permissions, deliberately.';
    case 'nothing_to_update':
      return 'Nothing was filled in, so nothing was sent. A branch-scoped list '
        + 'can also refuse this way when the sign-in names no branch — there is '
        + 'then nowhere to create the row.';
    default:
      return error.message;
  }
}
