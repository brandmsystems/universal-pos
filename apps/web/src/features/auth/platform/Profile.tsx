import { useEffect, useState } from 'react';
import type { Profile } from '../../../types/profile.js';
import type { ReactElement } from 'react';
import { LogOut } from 'lucide-react';
import { cn } from 'cn';
import { Button } from '@/components/ui/button.js';
import type { PlatformApi } from '../../../services/platformApi.js';
import { Modal, Notice, TextField, formatDate, refusalMessage } from '../../../components/platform/kit.js';

/** Two initials for the avatar; one if the name is a single word. */
function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return (parts.length > 1 ? parts[0]![0]! + parts[parts.length - 1]![0]! : (parts[0] ?? '?').slice(0, 2)).toUpperCase();
}

export function Avatar(props: { name: string; size?: 'sm' | 'lg' }): ReactElement {
  return (
    <span aria-hidden="true" className={cn(
      'flex shrink-0 items-center justify-center rounded-full bg-accent font-semibold text-accent-foreground',
      props.size === 'lg' ? 'size-12 text-base' : 'size-9 text-xs')}>
      {initials(props.name)}
    </span>
  );
}

/** The sidebar's account card. The whole card opens the account menu. */
export function ProfileCard(props: {
  profile: Profile | null; roleWord: string; onOpen: () => void;
}): ReactElement {
  const name = props.profile?.fullName ?? props.roleWord;
  return (
    <button type="button" onClick={props.onOpen}
      aria-label="Open account menu"
      className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition-colors hover:bg-secondary focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50">
      <Avatar name={name} />
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-sm font-semibold text-foreground">{name}</span>
        {props.profile !== null && (
          <span className="truncate text-xs text-muted-foreground">{props.profile.email}</span>
        )}
        <span className="truncate text-[11px] text-subtle-foreground">{props.roleWord}</span>
      </span>
    </button>
  );
}

/**
 * The account menu: who you are, and the two things you can do about it here --
 * change your password, or sign out. Changing the password asks for the
 * current one, because the server verifies it exactly as a login does.
 */
export function ProfileModal(props: {
  api: PlatformApi; open: boolean; profile: Profile | null; roleWord: string;
  onClose: () => void; onSignOut: () => void;
}): ReactElement | null {
  const [changing, setChanging] = useState(false);
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [busy, setBusy] = useState(false);
  const [refusal, setRefusal] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (!props.open) {
      setChanging(false); setCurrent(''); setNext(''); setConfirm('');
      setRefusal(null); setDone(false);
    }
  }, [props.open]);

  const nextError = next.length > 0 && next.length < 12 ? 'At least 12 characters.' : null;
  const confirmError = confirm.length > 0 && confirm !== next ? 'The two passwords do not match.' : null;
  const ready = !busy && current !== '' && next.length >= 12 && confirm === next;

  async function save(): Promise<void> {
    if (props.profile === null || !ready) return;
    setBusy(true); setRefusal(null);
    try {
      await props.api.changePassword({ email: props.profile.email, currentPassword: current, newPassword: next });
      setDone(true); setChanging(false); setCurrent(''); setNext(''); setConfirm('');
    } catch (error) {
      setRefusal(refusalMessage(error, 'the password was not changed'));
    } finally {
      setBusy(false);
    }
  }

  const p = props.profile;
  return (
    <Modal open={props.open} onClose={props.onClose} busy={busy} title="Your account"
      footer={changing ? (
        <>
          <Button type="button" variant="ghost" onClick={() => setChanging(false)} disabled={busy}>Cancel</Button>
          <Button type="button" onClick={() => { void save(); }} disabled={!ready}>
            {busy ? 'Saving…' : 'Change password'}
          </Button>
        </>
      ) : (
        <>
          <Button type="button" variant="ghost" onClick={props.onSignOut}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive">
            <LogOut className="size-4" /> Sign out
          </Button>
          <Button type="button" variant="outline" onClick={props.onClose}>Close</Button>
        </>
      )}>
      {p === null ? (
        <span className="text-sm text-muted-foreground">Your account details could not be read just now.</span>
      ) : (
        <div className="flex flex-col gap-4">
          <div className="flex items-center gap-3">
            <Avatar name={p.fullName} size="lg" />
            <div className="flex min-w-0 flex-col">
              <span className="truncate text-base font-semibold text-foreground">{p.fullName}</span>
              <span className="truncate text-sm text-muted-foreground">{p.email}</span>
            </div>
          </div>
          <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-2 text-sm">
            <dt className="text-subtle-foreground">Phone</dt>
            <dd className="font-mono text-foreground">{p.phone ?? '—'}</dd>
            <dt className="text-subtle-foreground">Role</dt>
            <dd className="text-foreground">{props.roleWord}</dd>
            <dt className="text-subtle-foreground">Account status</dt>
            <dd className={p.status === 'active' ? 'text-status-good' : 'text-status-critical'}>
              {p.status === 'active' ? 'Active' : p.status}
            </dd>
            <dt className="text-subtle-foreground">Last sign-in</dt>
            <dd className="font-mono text-xs text-muted-foreground">{formatDate(p.lastLoginAt)}</dd>
          </dl>

          {done && <Notice tone="success">Your password was changed. Use the new one next time you sign in.</Notice>}
          {refusal !== null && <Notice tone="error">{refusal}</Notice>}

          {changing ? (
            <div className="flex flex-col gap-3 border-t border-border pt-4">
              <TextField label="Current password" value={current} onChange={setCurrent} type="password" required />
              <TextField label="New password" value={next} onChange={setNext} type="password" required
                error={nextError} hint="At least 12 characters." />
              <TextField label="Confirm new password" value={confirm} onChange={setConfirm} type="password"
                required error={confirmError} />
            </div>
          ) : (
            <div className="border-t border-border pt-4">
              <Button type="button" variant="outline" size="sm" onClick={() => { setChanging(true); setDone(false); }}>
                Change password
              </Button>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
