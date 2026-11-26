import { Fragment, useCallback, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { PlatformApi } from '../../../services/platformApi.js';
import { Button } from '@/components/ui/button.js';
import { cn } from 'cn';
import { Notice, SelectField, TextField, refusalMessage } from '../../../components/platform/kit.js';

/**
 * A restaurant's sign-ins, managed by the Sales person who sold it (Super Admin:
 * any restaurant). The Sales person creates staff with a username and 4-digit
 * till PIN -- staff have no password (DECIDED 2026-10-17) -- and sets the
 * manager's username and password. Nobody else sets them. Staff sign in on the
 * till by tapping their name and typing the PIN; the manager with username and
 * password. The manager's ACCESS is not
 * changed here, only their sign-in. The server checks the rules, the plan's
 * user limit and which restaurants the caller may touch; this panel only stops
 * offering what it would refuse.
 */

type Access = 'pos' | 'orders' | 'billing';

const ACCESS_OPTIONS: readonly { value: Access; label: string }[] = [
  { value: 'pos', label: 'POS — orders, KOT and billing' },
  { value: 'orders', label: 'Orders and KOT only' },
  { value: 'billing', label: 'Billing only' },
];
const ACCESS_WORD = Object.fromEntries(ACCESS_OPTIONS.map((o) => [o.value, o.label])) as Record<Access, string>;

interface Member {
  readonly userId: string;
  readonly fullName: string;
  readonly staffCode: string | null;
  readonly status: string;
  readonly manages: boolean;
  readonly hasPassword: boolean;
  readonly hasPin: boolean;
  readonly access: Access | null;
  readonly roles: readonly string[];
}
interface StaffList { readonly members: readonly Member[]; readonly used: number; readonly limit: number }

/** The server's rules, so a form never offers a send it would refuse. */
const USERNAME = /^[A-Za-z0-9]{1,12}$/;
const passwordOk = (value: string): boolean => value.length >= 8 && value.length <= 200;
const PIN = /^\d{4}$/;

export function TenantStaff(props: { api: PlatformApi; tenantId: string }): ReactElement {
  const [list, setList] = useState<StaffList | null>(null);
  const [readFailed, setReadFailed] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [signInFor, setSignInFor] = useState<string | null>(null);
  const [pinFor, setPinFor] = useState<string | null>(null);

  const read = useCallback(async (): Promise<void> => {
    try {
      setList(await props.api.get<StaffList>(`/tenants/${props.tenantId}/staff`));
      setReadFailed(false);
    } catch {
      setReadFailed(true);
    }
  }, [props.api, props.tenantId]);
  useEffect(() => { void read(); }, [read]);

  async function act(what: string, run: () => Promise<unknown>): Promise<boolean> {
    setBusy(true); setRefusal(null); setDone(null);
    try {
      await run();
      setDone(what);
      await read();
      return true;
    } catch (error) {
      setRefusal(refusalMessage(error, 'nothing was changed'));
      return false;
    } finally {
      setBusy(false);
    }
  }

  const full = list !== null && list.used >= list.limit;

  return (
    <section className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">Sign-ins</span>
        {list !== null && (
          <span className={full ? 'text-xs font-semibold text-destructive' : 'text-xs text-muted-foreground'}>
            {list.used} of {list.limit} restaurant users{full ? ' — the plan\'s limit' : ''}
          </span>
        )}
      </div>
      <span className="text-xs text-muted-foreground">
        The manager signs in at the restaurant&apos;s page with the username and password set here. Staff open Staff
        Login on the till, tap their name and type the 4-digit PIN set here. Give them to the person yourself.
      </span>

      {readFailed && <Notice tone="error">The staff list did not load. Nothing is shown rather than an empty list.</Notice>}
      {refusal !== null && <Notice tone="error">{refusal}</Notice>}
      {done !== null && <Notice tone="success">{done}</Notice>}

      {list !== null && (
        <div className="overflow-x-auto rounded-md border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wide text-subtle-foreground">
                <th className="px-3 py-2">Name</th>
                <th className="px-3 py-2">Can use</th>
                <th className="px-3 py-2">Password</th>
                <th className="px-3 py-2">PIN</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {list.members.map((m) => {
                const open = editing === m.userId ? 'edit' : pinFor === m.userId ? 'pin' : signInFor === m.userId ? 'sign-in' : null;
                return (
                  <Fragment key={m.userId}>
                    <tr className={cn('align-top', open === null ? 'border-b border-border last:border-0' : 'bg-muted/30')}>
                      <td className="px-3 py-2.5">
                        <span className="font-semibold">{m.fullName}</span>
                        <span className="block font-mono text-xs text-muted-foreground">
                          Username: {m.staffCode ?? '— not set'}
                        </span>
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        {m.manages ? 'Manager' : m.access !== null ? ACCESS_WORD[m.access] : m.roles.join(', ') || '—'}
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        {!m.manages ? '—' : m.hasPassword ? 'Set' : <span className="text-status-warn">Not set</span>}
                      </td>
                      <td className="px-3 py-2.5 text-xs">{m.manages ? '—' : m.hasPin ? 'Set' : <span className="text-status-warn">Not set</span>}</td>
                      <td className="px-3 py-2.5 text-xs">{m.status === 'active' ? 'Active' : 'Switched off'}</td>
                      <td className="px-3 py-2">
                        {/* Wraps instead of pushing the table sideways; the open one is marked. */}
                        <div className="flex min-w-[170px] flex-wrap justify-end gap-1">
                          {!m.manages && (
                            <Button type="button" size="sm" variant={open === 'edit' ? 'default' : 'outline'} disabled={busy}
                              aria-expanded={open === 'edit'}
                              onClick={() => { setSignInFor(null); setPinFor(null); setEditing(open === 'edit' ? null : m.userId); }}>Edit</Button>
                          )}
                          {!m.manages && (
                            <Button type="button" size="sm" variant={open === 'pin' ? 'default' : 'outline'} disabled={busy}
                              aria-expanded={open === 'pin'}
                              onClick={() => { setSignInFor(null); setEditing(null); setPinFor(open === 'pin' ? null : m.userId); }}>
                              {m.hasPin ? 'Reset PIN' : 'Set PIN'}
                            </Button>
                          )}
                          {m.manages && (
                            <Button type="button" size="sm" variant={open === 'sign-in' ? 'default' : 'outline'} disabled={busy}
                              aria-expanded={open === 'sign-in'}
                              onClick={() => { setEditing(null); setPinFor(null); setSignInFor(open === 'sign-in' ? null : m.userId); }}>
                              {m.hasPassword ? 'Change sign-in' : 'Set sign-in'}
                            </Button>
                          )}
                          {!m.manages && (
                            <Button type="button" size="sm" variant="outline" disabled={busy || (m.status !== 'active' && full)}
                              title={m.status !== 'active' && full ? 'The plan has no room to switch another account on.' : undefined}
                              onClick={() => {
                                const on = m.status !== 'active';
                                void act(`${m.fullName} switched ${on ? 'on' : 'off'}.`,
                                  () => props.api.post(`/tenants/${props.tenantId}/staff/${m.userId}/active`, { active: on }));
                              }}>
                              {m.status === 'active' ? 'Switch off' : 'Switch on'}
                            </Button>
                          )}
                        </div>
                      </td>
                    </tr>
                    {open !== null && (
                      // The form gets the table's whole width, under its person -- never squeezed into the Name cell.
                      <tr className="border-b border-border bg-muted/30 last:border-0">
                        <td colSpan={6} className="px-3 pb-3">
                          <span className="mb-1 block text-xs font-semibold text-muted-foreground">
                            {open === 'edit' ? `Edit ${m.fullName}` : open === 'pin' ? `PIN for ${m.fullName}` : `Sign-in for ${m.fullName}`}
                          </span>
                          {open === 'edit' && (
                            <EditForm member={m} busy={busy} onCancel={() => setEditing(null)}
                              onSave={async (change) => {
                                if (await act(`${m.fullName} updated.`, () => props.api.patch(`/tenants/${props.tenantId}/staff/${m.userId}`, change))) {
                                  setEditing(null);
                                }
                              }} />
                          )}
                          {open === 'pin' && (
                            <PinForm busy={busy} onCancel={() => setPinFor(null)}
                              onSave={async (pin) => {
                                if (await act(`New PIN set for ${m.fullName}. Tell them in person.`,
                                  () => props.api.post(`/tenants/${props.tenantId}/staff/${m.userId}/pin`, { pin }))) {
                                  setPinFor(null);
                                }
                              }} />
                          )}
                          {open === 'sign-in' && (
                            <SignInForm member={m} busy={busy} onCancel={() => setSignInFor(null)}
                              onSave={async (input) => {
                                if (await act(`${m.fullName} now signs in as ${input.username.toUpperCase()} with the new password.`,
                                  () => props.api.post(`/tenants/${props.tenantId}/staff/${m.userId}/credentials`, input))) {
                                  setSignInFor(null);
                                }
                              }} />
                          )}
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {list !== null && !adding && (
        <div>
          <Button type="button" size="sm" disabled={full} onClick={() => setAdding(true)}
            title={full ? 'The plan allows no more restaurant users. Switch someone off to add another.' : undefined}>
            Add staff
          </Button>
          {full && (
            <span className="ml-2 text-xs text-destructive">
              All {list.limit} restaurant users are in use. Switch someone off to add another.
            </span>
          )}
        </div>
      )}
      {adding && (
        <AddForm busy={busy} onCancel={() => setAdding(false)}
          onSave={async (input) => {
            if (await act(`${input.fullName} can now sign in with Staff Login: tap their name and type the PIN. Tell them in person.`,
              () => props.api.post(`/tenants/${props.tenantId}/staff`, input))) {
              setAdding(false);
            }
          }} />
      )}
    </section>
  );
}

function UsernameField(props: { value: string; onChange: (v: string) => void }): ReactElement {
  return (
    <TextField label="Username" value={props.value} required mono placeholder="ASHA"
      onChange={(v) => props.onChange(v.replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toUpperCase())}
      hint="1 to 12 letters or digits." />
  );
}

function AddForm(props: {
  busy: boolean; onCancel: () => void;
  onSave: (input: { fullName: string; username: string; pin: string; access: Access }) => Promise<void>;
}): ReactElement {
  const [fullName, setFullName] = useState('');
  const [pin, setPin] = useState('');
  const [username, setUsername] = useState('');
  const [access, setAccess] = useState<Access>('pos');
  const ready = fullName.trim() !== '' && USERNAME.test(username) && PIN.test(pin);
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border p-3">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <TextField label="Name" value={fullName} onChange={setFullName} required placeholder="Asha" />
        <SelectField label="Can use" value={access} onChange={(v) => setAccess(v as Access)} options={ACCESS_OPTIONS} required />
        <UsernameField value={username} onChange={setUsername} />
        <PinField label="Till PIN" value={pin} onChange={setPin} />
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={props.busy || !ready}
          onClick={() => { void props.onSave({ fullName: fullName.trim(), username, pin, access }); }}>
          {props.busy ? 'Saving…' : 'Add staff'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function EditForm(props: {
  member: Member; busy: boolean; onCancel: () => void;
  onSave: (change: Record<string, unknown>) => Promise<void>;
}): ReactElement {
  const [fullName, setFullName] = useState(props.member.fullName);
  const [username, setUsername] = useState(props.member.staffCode ?? '');
  const [access, setAccess] = useState<Access>(props.member.access ?? 'pos');
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <TextField label="Name" value={fullName} onChange={setFullName} required />
        <SelectField label="Can use" value={access} onChange={(v) => setAccess(v as Access)} options={ACCESS_OPTIONS} />
        <UsernameField value={username} onChange={setUsername} />
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={props.busy || fullName.trim() === '' || !USERNAME.test(username)}
          onClick={() => {
            const change: Record<string, unknown> = {};
            if (fullName.trim() !== props.member.fullName) change['fullName'] = fullName.trim();
            if (username !== (props.member.staffCode ?? '')) change['username'] = username;
            if (access !== props.member.access) change['access'] = access;
            void props.onSave(change);
          }}>
          {props.busy ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>Cancel</Button>
      </div>
    </div>
  );
}

function PinField(props: { label: string; value: string; onChange: (v: string) => void }): ReactElement {
  return (
    <TextField label={props.label} type="password" value={props.value} required mono
      onChange={(v) => props.onChange(v.replace(/\D/g, '').slice(0, 4))}
      hint="Exactly 4 digits. Not 0000, 1234 or a run. Typed on the till after tapping their name." />
  );
}

/** A new till PIN; the old one stops working at once. */
function PinForm(props: { busy: boolean; onCancel: () => void; onSave: (pin: string) => Promise<void> }): ReactElement {
  const [pin, setPin] = useState('');
  return (
    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border bg-card p-3">
      <PinField label="New PIN" value={pin} onChange={setPin} />
      <Button type="button" size="sm" disabled={props.busy || !PIN.test(pin)} onClick={() => { void props.onSave(pin); }}>
        {props.busy ? 'Saving…' : 'Set PIN'}
      </Button>
      <Button type="button" size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>Cancel</Button>
    </div>
  );
}

/** The manager's new username and password; the old password stops working at once. */
function SignInForm(props: {
  member: Member; busy: boolean; onCancel: () => void;
  onSave: (input: { username: string; password: string }) => Promise<void>;
}): ReactElement {
  const [username, setUsername] = useState(props.member.staffCode ?? '');
  const [password, setPassword] = useState('');
  const ready = USERNAME.test(username) && passwordOk(password);
  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-card p-3">
      <div className="grid gap-2.5 sm:grid-cols-2">
        <UsernameField value={username} onChange={setUsername} />
        <TextField label="Password" type="password" value={password} required onChange={setPassword}
          hint="At least 8 characters." />
      </div>
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={props.busy || !ready}
          onClick={() => { void props.onSave({ username, password }); }}>
          {props.busy ? 'Saving…' : 'Save sign-in'}
        </Button>
        <Button type="button" size="sm" variant="ghost" disabled={props.busy} onClick={props.onCancel}>Cancel</Button>
      </div>
    </div>
  );
}
