import { useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { PlatformApiError, type PlatformApi } from '../../../services/platformApi.js';
import { known, unknown, type Remote } from '../../../lib/remote.js';
import { cn } from 'cn';
import { UserPlus } from 'lucide-react';
import { Button } from '@/components/ui/button.js';
import { Input } from '@/components/ui/input.js';
import { PasswordInput } from '@/components/ui/password-input.js';
import { Label } from '@/components/ui/label.js';
import { Card } from '@/components/ui/card.js';
import { Alert, AlertDescription } from '@/components/ui/alert.js';
import { CopyField } from '../../../components/platform/kit.js';
import { Pagination, TableToolbar, useClientTable } from '../../../components/platform/Pagination.js';
import { ListSkeleton } from '../../../components/platform/skeletons.js';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table.js';

/**
 * The platform's own staff directory.
 *
 * ###########################################################################
 * `platform.user.create` HAS BEEN IN THE CATALOGUE SINCE PHASE 1.
 *
 * Nothing ever served it. The only way to add a Salesperson, Support or
 * Billing account was `scripts/development/seed-platform-user.mts` -- shell and database
 * access, reserved in its own docstring for bootstrapping the first Super
 * Admin. So a Super Admin could see this console's other screens and still
 * could not onboard the next person who needed one. Same shape as `POST
 * /tenants` before this week: a permission key and a table with no door.
 * ###########################################################################
 *
 * The password is set here, not invited. A tenant owner gets an invite token
 * because there is a plane boundary between who provisions a restaurant and
 * who will run it -- superadmin must never hold a tenant credential. There is
 * no such boundary between one platform user and the next: both are staff on
 * the same plane, and there is no accept-invite surface or outbox topic for
 * this table to send one through. Building one would be new unbuilt UI
 * standing between this screen and the one thing it needs to do today.
 */

/** The fixed five, same set `platform.platform_role_key_known` enforces. A
 * client copy of catalogue vocabulary, same shape as `tokens.ts`'s status
 * word maps -- it can only grow by a migration, which is the forcing
 * function that keeps it honest. */
const ROLE_OPTIONS: readonly { key: string; label: string }[] = [
  { key: 'super_admin', label: 'Super Admin' },
  { key: 'sales', label: 'Salesperson' },
  { key: 'support', label: 'Support' },
  { key: 'billing', label: 'Billing' },
  { key: 'read_only', label: 'Read Only' },
];

interface StaffSummary {
  readonly platformUserId: string;
  readonly email: string;
  readonly fullName: string;
  readonly roleKey: string;
  readonly roleName: string;
  readonly status: string;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
}

const selectClass =
  'h-10 w-full rounded-md border border-input bg-transparent px-2.5 text-sm text-foreground '
  + 'focus-visible:border-ring focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50';

export function Staff(props: { api: PlatformApi }): ReactElement {
  const [rows, setRows] = useState<Remote<readonly StaffSummary[]>>(
    unknown<readonly StaffSummary[]>());
  const [creating, setCreating] = useState(false);

  const [email, setEmail] = useState('');
  const [fullName, setFullName] = useState('');
  const [password, setPassword] = useState('');
  const [roleKey, setRoleKey] = useState('');
  const [created, setCreated] = useState<{ email: string; password: string } | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');

  const table = useClientTable(rows.state === 'unknown' ? [] : rows.value, {
    haystack: (user) => [user.fullName, user.email, user.roleName],
    keep: (user) => (roleFilter === '' || user.roleKey === roleFilter)
      && (statusFilter === '' || user.status === statusFilter),
    filterKey: `${roleFilter}|${statusFilter}`,
  });
  const statuses = rows.state === 'unknown' ? [] : [...new Set(rows.value.map((u) => u.status))].sort();

  const read = useCallback(async (): Promise<void> => {
    try {
      setRows(known(await props.api.get<readonly StaffSummary[]>('/users')));
    } catch (error) {
      setRows(unknown<readonly StaffSummary[]>(
        error instanceof PlatformApiError && error.failure.kind === 'refused'
          && error.failure.status === 403 ? 'not-permitted' : 'read-failed'));
    }
  }, [props.api]);

  useEffect(() => { void read(); }, [read]);

  const ready = !busy && email.trim() !== '' && fullName.trim() !== ''
    && password.length >= 12 && roleKey !== '';

  async function submit(): Promise<void> {
    setBusy(true); setRefusal(null); setCreated(null);
    try {
      await props.api.post('/users', {
        email: email.trim(), fullName: fullName.trim(), password, roleKey,
      });
      setCreated({ email: email.trim(), password });
      setEmail(''); setFullName(''); setPassword(''); setRoleKey('');
      await read();
    } catch (error) {
      setRefusal(error instanceof PlatformApiError
        ? error.failure.kind === 'refused'
          ? error.message.charAt(0).toUpperCase() + error.message.slice(1)
          : 'The server could not be reached, so nothing was created.'
        : 'That did not go through.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col items-start justify-between gap-3 sm:flex-row sm:items-baseline">
        <div className="flex flex-col gap-1.5">
          <span className="text-xl font-bold tracking-tight sm:text-2xl">Platform staff</span>
          <span className="max-w-[680px] text-sm leading-relaxed text-muted-foreground">
            Who can sign in to this console, and with which of the five fixed
            roles. Not tenant staff — a restaurant&rsquo;s own team is invited
            from inside that restaurant.
          </span>
        </div>
        <Button type="button" className="w-full sm:w-auto"
          onClick={() => { setCreating((c) => !c); setCreated(null); }}>
          {!creating && <UserPlus className="size-4" />} {creating ? 'Close' : 'New platform user'}
        </Button>
      </div>

      {creating && (
        <Card className="gap-3.5 border-2 border-primary/40 p-5">
          {created !== null ? (
            <div className="flex flex-col gap-2 rounded-lg border border-primary/40 bg-primary/10 p-4">
              <span className="text-sm font-bold text-primary">{created.email} was created.</span>
              <span className="text-sm leading-relaxed text-foreground">
                There is no invite flow on this plane — hand them this password
                directly, the same way the bootstrap script always has. It is
                shown once and not stored anywhere this screen can read again.
              </span>
              <CopyField label="Password" value={created.password} secret />
            </div>
          ) : (
            <>
              <div className="flex flex-wrap gap-3.5">
                <div className="flex flex-1 flex-col gap-1.5" style={{ flexBasis: 220 }}>
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Email
                  </Label>
                  <Input value={email} onChange={(e) => setEmail(e.target.value)}
                    placeholder="name@universalpos.local" className="h-10" />
                </div>
                <div className="flex flex-1 flex-col gap-1.5" style={{ flexBasis: 220 }}>
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Full name
                  </Label>
                  <Input value={fullName} onChange={(e) => setFullName(e.target.value)}
                    className="h-10" />
                </div>
              </div>
              <div className="flex flex-wrap gap-3.5">
                <div className="flex flex-1 flex-col gap-1.5" style={{ flexBasis: 220 }}>
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Password
                  </Label>
                  <PasswordInput value={password} autoComplete="new-password"
                    onChange={(e) => setPassword(e.target.value)}
                    className="h-10 font-mono" />
                  <span className="text-[11px] text-muted-foreground">
                    at least 12 characters — set here, not chosen by them
                  </span>
                </div>
                <div className="flex flex-1 flex-col gap-1.5" style={{ flexBasis: 220 }}>
                  <Label className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                    Role
                  </Label>
                  <select value={roleKey} onChange={(e) => setRoleKey(e.target.value)}
                    className={selectClass}>
                    <option value="">— choose a role —</option>
                    {ROLE_OPTIONS.map((option) => (
                      <option key={option.key} value={option.key}>{option.label}</option>
                    ))}
                  </select>
                </div>
              </div>

              {refusal !== null && (
                <Alert variant="destructive">
                  <AlertDescription>{refusal}</AlertDescription>
                </Alert>
              )}

              <div>
                <Button type="button" onClick={() => { void submit(); }} disabled={!ready}>
                  {busy ? 'Creating…' : 'Create platform user'}
                </Button>
              </div>
            </>
          )}
        </Card>
      )}

      {rows.state === 'unknown' && rows.reason === 'never-read' ? (
        <ListSkeleton label="platform staff" toolbar columns={['Name', 'Email', 'Role', 'Status', 'Last sign-in']} />
      ) : rows.state === 'unknown' ? (
        <div className="rounded-lg border border-dashed border-border p-4 text-sm leading-relaxed text-muted-foreground">
          {rows.reason === 'not-permitted'
            ? 'This role cannot read the platform staff directory.'
            : 'The staff list could not be read just now.'}
        </div>
      ) : (
        <>
          <TableToolbar query={table.query} onQuery={table.setQuery}
            placeholder="Search name, email or role" label="Search platform staff"
            filtersActive={roleFilter !== '' || statusFilter !== ''}
            onClear={() => { setRoleFilter(''); setStatusFilter(''); }}>
            <select aria-label="Filter by role" value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)} className={cn(selectClass, 'h-9 sm:w-44')}>
              <option value="">All roles</option>
              {ROLE_OPTIONS.map((option) => (
                <option key={option.key} value={option.key}>{option.label}</option>
              ))}
            </select>
            <select aria-label="Filter by status" value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)} className={cn(selectClass, 'h-9 sm:w-40')}>
              <option value="">All statuses</option>
              {statuses.map((status) => <option key={status} value={status}>{status}</option>)}
            </select>
          </TableToolbar>
          <div className="rounded-lg border border-border bg-card">
            <Table>
              <TableHeader>
                <TableRow className="hover:bg-transparent">
                  <TableHead>Name</TableHead>
                  <TableHead>Email</TableHead>
                  <TableHead>Role</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Last sign-in</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {table.matched.length === 0 && (
                  <TableRow className="hover:bg-transparent">
                    <TableCell colSpan={5} className="py-8 text-center text-sm text-muted-foreground">
                      No platform user matches this search.
                    </TableCell>
                  </TableRow>
                )}
                {table.visible.map((user) => (
                  <TableRow key={user.platformUserId}>
                    <TableCell className="font-medium">{user.fullName}</TableCell>
                    <TableCell className="font-mono text-xs">{user.email}</TableCell>
                    <TableCell>{user.roleName}</TableCell>
                    <TableCell>
                      <span className={cn(
                        'font-semibold',
                        user.status === 'active' ? 'text-muted-foreground' : 'text-destructive',
                      )}>
                        {user.status}
                      </span>
                    </TableCell>
                    <TableCell className="font-mono text-xs text-muted-foreground">
                      {user.lastLoginAt === null ? 'never' : user.lastLoginAt.slice(0, 10)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
          <Pagination page={table.page} total={table.matched.length} pageSize={table.pageSize}
            noun="platform users" onPage={table.setPage} />
        </>
      )}
    </div>
  );
}
