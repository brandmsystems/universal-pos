import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { PlatformApi } from '../../../services/platformApi.js';
import { known, unknown, type Remote } from '../../../lib/remote.js';
import { cn } from 'cn';
import { KeyRound, Pencil, Power, PowerOff, UserPlus, X } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table.js';
import { CopyField, Modal, Notice, TextField, failedRead, refusalMessage, selectClass } from '../../../components/platform/kit.js';
import { Pagination, TableToolbar, useClientTable } from '../../../components/platform/Pagination.js';
import { ListSkeleton } from '../../../components/platform/skeletons.js';

/**
 * The sales team: who sells, how much of it is still live, and what it brought in.
 *
 * "Sold" is the restaurants a rep PROVISIONED -- the same row the restaurant
 * list and the rep's own dashboard read -- so the count here cannot disagree
 * with the rows they see. A rep is a platform user with the `sales` role; this
 * page creates them through the same `POST /users` the Platform staff page uses,
 * with the role fixed, and is governed by the same subset rule at the server.
 */

interface SalesPerson {
  readonly platformUserId: string;
  readonly email: string;
  readonly fullName: string;
  readonly phone: string | null;
  readonly status: string;
  readonly lastLoginAt: string | null;
  readonly restaurantsSold: number;
  readonly activeRestaurants: number;
  readonly activeSubscriptions: number;
  readonly expiringSoon: number;
  readonly expired: number;
  readonly revenueMinor: number;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const PHONE = /^\+?[0-9][0-9 ()-]{5,19}$/;

export function SalesPersons(props: { api: PlatformApi; selfId: string }): ReactElement {
  const [rows, setRows] = useState<Remote<readonly SalesPerson[]>>(unknown<readonly SalesPerson[]>());
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('');
  const [flash, setFlash] = useState<string | null>(null);
  const [editing, setEditing] = useState<SalesPerson | 'new' | null>(null);
  const [toggling, setToggling] = useState<SalesPerson | null>(null);
  const [resetting, setResetting] = useState<SalesPerson | null>(null);

  const read = useCallback(async (): Promise<void> => {
    setLoading(true);
    try {
      setRows(known(await props.api.get<readonly SalesPerson[]>('/sales-persons')));
    } catch (error) {
      setRows((current) => failedRead(error, current));
    } finally {
      setLoading(false);
    }
  }, [props.api]);

  useEffect(() => { void read(); }, [read]);

  const all = rows.state === 'unknown' ? [] : rows.value;
  const table = useClientTable(all, {
    haystack: (p) => [p.fullName, p.email, p.phone],
    keep: (p) => statusFilter === '' || p.status === statusFilter,
    filterKey: statusFilter,
  });
  const visible = table.visible;
  const statuses = [...new Set(all.map((p) => p.status))].sort();

  const done = (message: string): void => { setFlash(message); void read(); };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-col gap-1.5">
          <span className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Sales persons</span>
          <span className="max-w-[640px] text-sm leading-relaxed text-muted-foreground">
            Who sells the platform. A sales person creates restaurants and sees only
            their own; each restaurant they create is credited to them here.
          </span>
        </div>
        <Button type="button" className="w-full sm:w-auto" onClick={() => setEditing('new')}>
          <UserPlus className="size-4" /> Add sales person
        </Button>
      </div>

      {flash !== null && (
        <Notice tone="success">
          <span className="flex items-start justify-between gap-3">
            {flash}
            <button type="button" onClick={() => setFlash(null)} aria-label="Dismiss"
              className="text-muted-foreground hover:text-foreground"><X className="size-4" /></button>
          </span>
        </Notice>
      )}

      {rows.state === 'unknown' ? (
        loading ? (
          <ListSkeleton label="sales persons" toolbar cardsBelow="lg" headClassName={HEAD}
            columns={['Name', 'Email', 'Phone', 'Restaurants', 'Active subs', 'Expiring soon', 'Expired', 'Status', 'Actions']} />
        ) : (
          <div className="rounded-lg border border-dashed border-border p-4 text-sm text-muted-foreground">
            {rows.reason === 'not-permitted'
              ? 'Your role cannot read the sales team.'
              : 'The sales team could not be read just now.'}
          </div>
        )
      ) : all.length === 0 ? (
        <div className="flex flex-col items-center gap-3 rounded-lg border border-dashed border-border px-4 py-10 text-center">
          <span className="text-sm text-muted-foreground">No sales persons yet.</span>
          <Button type="button" size="sm" onClick={() => setEditing('new')}>
            <UserPlus className="size-4" /> Add sales person
          </Button>
        </div>
      ) : (
        <>
          <TableToolbar query={table.query} onQuery={table.setQuery}
            placeholder="Search name, email or phone" label="Search sales persons"
            filtersActive={statusFilter !== ''} onClear={() => setStatusFilter('')}>
            <select aria-label="Filter by status" value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)} className={cn(selectClass, 'h-9 sm:w-40')}>
              <option value="">All statuses</option>
              {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </TableToolbar>

          {table.matched.length === 0 && (
            <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
              No sales person matches this search.
            </div>
          )}

          <div className={cn('hidden rounded-lg border border-border bg-card', table.matched.length > 0 && 'lg:block')}>
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead className={HEAD}>Name</TableHead>
                  <TableHead className={HEAD}>Email</TableHead>
                  <TableHead className={HEAD}>Phone</TableHead>
                  <TableHead className={cn(HEAD, 'text-right')}>Restaurants</TableHead>
                  <TableHead className={cn(HEAD, 'text-right')}>Active subs</TableHead>
                  <TableHead className={cn(HEAD, 'text-right')}>Expiring soon</TableHead>
                  <TableHead className={cn(HEAD, 'text-right')}>Expired</TableHead>
                  <TableHead className={HEAD}>Status</TableHead>
                  <TableHead className={cn(HEAD, 'text-right')}>Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {visible.map((p) => (
                  <TableRow key={p.platformUserId} className="border-border/60">
                    <TableCell className="py-2.5 font-medium text-foreground">{p.fullName}</TableCell>
                    <TableCell className="py-2.5 text-xs text-muted-foreground">{p.email}</TableCell>
                    <TableCell className="py-2.5 font-mono text-xs text-muted-foreground">{p.phone ?? '—'}</TableCell>
                    <TableCell className="py-2.5 text-right tabular-nums text-foreground">{p.restaurantsSold}</TableCell>
                    <TableCell className="py-2.5 text-right tabular-nums text-foreground">{p.activeSubscriptions}</TableCell>
                    <TableCell className={cn('py-2.5 text-right tabular-nums', p.expiringSoon > 0 ? 'text-status-warn' : 'text-muted-foreground')}>
                      {p.expiringSoon}
                    </TableCell>
                    <TableCell className={cn('py-2.5 text-right tabular-nums', p.expired > 0 ? 'text-status-critical' : 'text-muted-foreground')}>
                      {p.expired}
                    </TableCell>
                    <TableCell className="py-2.5"><StatusWord status={p.status} /></TableCell>
                    <TableCell className="py-2.5">
                      <RowActions person={p} selfId={props.selfId} onEdit={setEditing} onToggle={setToggling}
                        onReset={setResetting} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>

          <div className="flex flex-col gap-2.5 lg:hidden">
            {visible.map((p) => (
              <div key={p.platformUserId} className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate font-medium text-foreground">{p.fullName}</span>
                    <span className="truncate text-xs text-muted-foreground">{p.email}</span>
                    {p.phone !== null && <span className="font-mono text-xs text-subtle-foreground">{p.phone}</span>}
                  </div>
                  <StatusWord status={p.status} />
                </div>
                <div className="grid grid-cols-4 gap-2 text-xs">
                  <Figure label="Restaurants" value={String(p.restaurantsSold)} />
                  <Figure label="Active" value={String(p.activeSubscriptions)} />
                  <Figure label="Expiring" value={String(p.expiringSoon)} />
                  <Figure label="Expired" value={String(p.expired)} />
                </div>
                <div className="flex justify-end border-t border-border/60 pt-2">
                  <RowActions person={p} selfId={props.selfId} onEdit={setEditing} onToggle={setToggling}
                    onReset={setResetting} />
                </div>
              </div>
            ))}
          </div>

          <Pagination page={table.page} total={table.matched.length} pageSize={table.pageSize} noun="sales persons"
            onPage={(next) => { table.setPage(next); window.scrollTo({ top: 0 }); }} />
        </>
      )}

      <SalesPersonModal api={props.api} target={editing} onClose={() => setEditing(null)} onSaved={done} />
      <SalesPersonStatusModal api={props.api} target={toggling} onClose={() => setToggling(null)} onChanged={done} />
      <ResetPasswordModal api={props.api} target={resetting} onClose={() => setResetting(null)} />
    </div>
  );
}

const HEAD = 'h-9 text-[11px] font-medium uppercase tracking-wide text-subtle-foreground';

function Figure(props: { label: string; value: string }): ReactElement {
  return (
    <div className="flex flex-col">
      <span className="text-subtle-foreground">{props.label}</span>
      <span className="font-medium tabular-nums text-foreground">{props.value}</span>
    </div>
  );
}

function StatusWord(props: { status: string }): ReactElement {
  return (
    <span className={cn('text-xs font-semibold',
      props.status === 'active' ? 'text-status-good' : 'text-status-critical')}>
      {props.status === 'active' ? 'Active' : props.status === 'disabled' ? 'Deactivated' : 'Locked'}
    </span>
  );
}

const iconButton =
  'inline-flex size-8 pointer-coarse:size-10 items-center justify-center rounded-md text-muted-foreground transition-colors '
  + 'hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

function RowActions(props: {
  person: SalesPerson; selfId: string;
  onEdit: (p: SalesPerson) => void; onToggle: (p: SalesPerson) => void;
  onReset: (p: SalesPerson) => void;
}): ReactElement {
  const p = props.person;
  // `suspended` is the login lockout, owned by the sign-in path; this page
  // switches between active and disabled only, as the server does.
  const toggle = p.platformUserId !== props.selfId && (p.status === 'active' || p.status === 'disabled');
  return (
    <div className="flex items-center justify-end gap-0.5">
      <button type="button" className={iconButton} onClick={() => props.onEdit(p)}
        aria-label={`Edit ${p.fullName}`} title="Edit"><Pencil className="size-4" /></button>
      {p.platformUserId !== props.selfId && (
        <button type="button" className={iconButton} onClick={() => props.onReset(p)}
          aria-label={`Reset password for ${p.fullName}`} title="Reset password">
          <KeyRound className="size-4" />
        </button>
      )}
      {toggle && (
        <button type="button" onClick={() => props.onToggle(p)}
          className={cn(iconButton, p.status === 'active'
            ? 'hover:bg-destructive/10 hover:text-destructive' : 'hover:bg-primary/10 hover:text-primary')}
          aria-label={`${p.status === 'active' ? 'Deactivate' : 'Activate'} ${p.fullName}`}
          title={p.status === 'active' ? 'Deactivate' : 'Activate'}>
          {p.status === 'active' ? <PowerOff className="size-4" /> : <Power className="size-4" />}
        </button>
      )}
    </div>
  );
}

function SalesPersonModal(props: {
  api: PlatformApi;
  target: SalesPerson | 'new' | null;
  onClose: () => void;
  onSaved: (message: string) => void;
}): ReactElement | null {
  const creating = props.target === 'new';
  const existing = props.target !== 'new' ? props.target : null;
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [touched, setTouched] = useState(false);
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);

  useEffect(() => {
    setFullName(existing?.fullName ?? ''); setEmail(existing?.email ?? '');
    setPhone(existing?.phone ?? ''); setPassword('');
    setTouched(false); setRefusal(null); setCreated(null);
  }, [props.target]); // eslint-disable-line react-hooks/exhaustive-deps

  const errors = {
    fullName: fullName.trim().length < 2 ? 'At least 2 characters.' : null,
    email: !EMAIL.test(email.trim()) ? 'A valid email address is required.' : null,
    phone: phone.trim() !== '' && !PHONE.test(phone.trim())
      ? 'Digits, spaces, dashes and an optional leading +.' : null,
    password: creating && password.length < 12 ? 'At least 12 characters.' : null,
  };
  const valid = Object.values(errors).every((e) => e === null);
  const show = (e: string | null): string | null => (touched ? e : null);

  async function save(): Promise<void> {
    setTouched(true);
    if (!valid) return;
    setBusy(true); setRefusal(null);
    try {
      if (creating) {
        await props.api.post('/users', {
          fullName: fullName.trim(), email: email.trim(), phone: phone.trim(),
          password, roleKey: 'sales',
        });
        setCreated({ email: email.trim(), password });
        props.onSaved(`${fullName.trim()} was added as a sales person.`);
      } else if (existing !== null) {
        await props.api.patch(`/users/${existing.platformUserId}`, {
          fullName: fullName.trim(), email: email.trim(), phone: phone.trim(),
        });
        props.onSaved(`${fullName.trim()} was updated.`);
        props.onClose();
      }
    } catch (error) {
      setRefusal(refusalMessage(error, 'nothing was saved'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={props.target !== null} onClose={props.onClose} busy={busy}
      title={created !== null ? 'Sales person added' : creating ? 'Add sales person' : 'Edit sales person'}
      footer={created !== null ? <Button type="button" onClick={props.onClose}>Done</Button> : (
        <>
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={() => { void save(); }} disabled={busy || (touched && !valid)}>
            {busy ? 'Saving…' : creating ? 'Add sales person' : 'Save changes'}
          </Button>
        </>
      )}>
      {created !== null ? (
        <div className="flex flex-col gap-3">
          <Notice tone="success">
            Share these sign-in details with them directly. The password is shown
            once and is not stored anywhere this console can show it again.
          </Notice>
          <CopyField label="Email" value={created.email} />
          <CopyField label="Password" value={created.password} secret />
        </div>
      ) : (
        <div className="flex flex-col gap-3.5">
          {refusal !== null && <Notice tone="error">{refusal}</Notice>}
          <TextField label="Full name" value={fullName} onChange={setFullName} required error={show(errors.fullName)} />
          <div className="grid gap-3.5 sm:grid-cols-2">
            <TextField label="Email" value={email} onChange={setEmail} type="email" required
              error={show(errors.email)} hint="They sign in with this." />
            <TextField label="Phone" value={phone} onChange={setPhone} type="tel"
              placeholder="+91 98450 12345" error={show(errors.phone)} />
          </div>
          {creating && (
            <TextField label="Password" value={password} onChange={setPassword} mono required type="password"
              error={show(errors.password)} hint="At least 12 characters. You hand it to them; it is shown once." />
          )}
        </div>
      )}
    </Modal>
  );
}

function SalesPersonStatusModal(props: {
  api: PlatformApi;
  target: SalesPerson | null;
  onClose: () => void;
  onChanged: (message: string) => void;
}): ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  useEffect(() => { setRefusal(null); }, [props.target]);
  const deactivating = props.target?.status === 'active';

  async function confirm(): Promise<void> {
    if (props.target === null) return;
    setBusy(true); setRefusal(null);
    try {
      await props.api.post(`/users/${props.target.platformUserId}/status`,
        { status: deactivating ? 'disabled' : 'active' });
      props.onChanged(deactivating
        ? `${props.target.fullName} can no longer sign in. Their restaurants are unaffected.`
        : `${props.target.fullName} can sign in again.`);
      props.onClose();
    } catch (error) {
      setRefusal(refusalMessage(error, 'nothing was changed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={props.target !== null} onClose={props.onClose} busy={busy}
      title={`${deactivating ? 'Deactivate' : 'Activate'} ${props.target?.fullName ?? ''}`}
      description={deactivating
        ? 'They will not be able to sign in. Restaurants they sold stay exactly as they are, and still count towards them.'
        : 'They will be able to sign in again and see their restaurants.'}
      footer={(
        <>
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={busy}>Cancel</Button>
          <Button type="button" variant={deactivating ? 'destructive' : 'default'}
            onClick={() => { void confirm(); }} disabled={busy}>
            {busy ? 'Working…' : deactivating ? 'Deactivate' : 'Activate'}
          </Button>
        </>
      )}>
      {refusal !== null ? <Notice tone="error">{refusal}</Notice>
        : <span className="text-sm text-muted-foreground">{props.target?.email}</span>}
    </Modal>
  );
}

/**
 * A new password, generated by the server and shown once. The old one is never
 * shown because it is not stored anywhere readable -- only its hash is -- so
 * "what is their password" is always answered by issuing a new one.
 */
function ResetPasswordModal(props: {
  api: PlatformApi; target: SalesPerson | null; onClose: () => void;
}): ReactElement | null {
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [issued, setIssued] = useState<{ email: string; password: string } | null>(null);
  useEffect(() => { setRefusal(null); setIssued(null); }, [props.target]);

  async function reset(): Promise<void> {
    if (props.target === null) return;
    setBusy(true); setRefusal(null);
    try {
      setIssued(await props.api.post<{ email: string; password: string }>(
        `/users/${props.target.platformUserId}/password`, {}));
    } catch (error) {
      setRefusal(refusalMessage(error, 'the password was not changed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open={props.target !== null} onClose={props.onClose} busy={busy}
      title={`Reset password for ${props.target?.fullName ?? ''}`}
      description={issued === null
        ? 'Their current password stops working immediately, and any lockout is cleared. The new password is shown once.'
        : undefined}
      footer={issued !== null ? <Button type="button" onClick={props.onClose}>Done</Button> : (
        <>
          <Button type="button" variant="ghost" onClick={props.onClose} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={() => { void reset(); }} disabled={busy}>
            {busy ? 'Resetting…' : 'Reset password'}
          </Button>
        </>
      )}>
      {refusal !== null && <Notice tone="error">{refusal}</Notice>}
      {issued !== null && (
        <div className="flex flex-col gap-3">
          <Notice tone="success">Hand these to them directly. They are not shown again.</Notice>
          <CopyField label="Email" value={issued.email} />
          <CopyField label="New password" value={issued.password} secret />
        </div>
      )}
    </Modal>
  );
}
