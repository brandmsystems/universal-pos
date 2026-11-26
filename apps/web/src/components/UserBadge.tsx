import { useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import type { Api } from '../services/api.js';

/**
 * Who is signed in, in every screen's header: KOT, KDS, Billing and admin.
 *
 * Read from `GET /me`, which answers only for the verified token -- never from
 * anything this browser remembers, so a name on screen is the server's.
 * Colours inherit from the header it sits in (dark on Billing and the kitchen,
 * light on KOT and admin); only the open panel sets its own.
 */

interface Me {
  readonly kind: 'staff' | 'impersonation';
  readonly fullName: string | null;
  readonly employeeCode: string | null;
  readonly email: string | null;
  readonly roles: readonly { roleName: string; branchName: string | null }[];
  readonly branchName: string | null;
  readonly deviceName: string | null;
}

export function UserBadge(props: {
  api: Api; className?: string; opens?: 'down' | 'up';
  /** Fill the width it is given, as in the admin sidebar; otherwise size to the text, capped. */
  block?: boolean;
}): ReactElement | null {
  const [me, setMe] = useState<Me | null>(null);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let live = true;
    props.api.get<Me>('/me').then((read) => { if (live) setMe(read); }).catch(() => undefined);
    return () => { live = false; };
  }, [props.api]);

  // Nothing rather than a guess: a badge naming the wrong person is worse than none.
  if (me === null) return null;

  const name = me.kind === 'impersonation' ? 'Platform support' : (me.fullName ?? 'Signed in');
  // The roles that apply HERE: held at this branch, or restaurant-wide.
  const here = me.roles.filter((r) => r.branchName === null || r.branchName === me.branchName);
  const roleLine = (here.length > 0 ? here : me.roles).map((r) => r.roleName).join(' + ');
  const detail = [me.employeeCode ?? me.email, me.branchName, me.deviceName].filter(Boolean).join(' · ');

  return (
    <div className={`relative min-w-0 ${props.block ? 'w-auto' : 'max-w-72'} ${props.className ?? ''}`}>
      {/* One fact per line, each cut with an ellipsis: a long name or a
          two-role line must never widen the badge past the place it sits in. */}
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open}
        title={[name, roleLine, detail].filter(Boolean).join('\n')}
        className={`flex min-h-11 min-w-0 items-center gap-2.5 rounded-md border border-current/25 px-3 py-1.5 text-left ${props.block ? 'w-full' : 'max-w-full'}`}>
        <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-current/15 text-sm font-bold">
          {name.slice(0, 1).toUpperCase()}
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-tight">
          <span className="truncate text-sm font-semibold">{name}</span>
          {roleLine && <span className="truncate text-xs opacity-80">{roleLine}</span>}
          {detail && <span className="truncate text-xs opacity-60">{detail}</span>}
        </span>
      </button>

      {open && (
        // A block badge sits in a narrow scrolling sidebar: a fixed width would overflow
        // it and cut the panel off, so the panel takes the badge's width and stacks.
        <div role="dialog" aria-label="Signed in as"
          className={`absolute z-50 ${props.block ? 'inset-x-0' : 'w-72'} ${props.opens === 'up' ? `bottom-full mb-2 ${props.block ? '' : 'left-0'}` : `mt-2 ${props.block ? '' : 'right-0'}`} rounded-lg border border-border bg-card p-4 text-sm text-foreground shadow-lg`}>
          <dl className={props.block
            ? 'flex flex-col [&>dd]:mb-2 [&>dd]:break-words [&>dd:last-child]:mb-0 [&>dt]:text-xs'
            : 'grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5'}>
            <dt className="text-muted-foreground">Name</dt><dd className="font-semibold">{name}</dd>
            {me.employeeCode && (<><dt className="text-muted-foreground">Staff code</dt><dd className="font-mono">{me.employeeCode}</dd></>)}
            {me.email && (<><dt className="text-muted-foreground">Email</dt><dd className="break-all">{me.email}</dd></>)}
            <dt className="text-muted-foreground">Branch</dt><dd>{me.branchName ?? 'All branches'}</dd>
            <dt className="text-muted-foreground">Tablet</dt><dd>{me.deviceName ?? 'Not a tablet sign-in'}</dd>
            <dt className="text-muted-foreground">Roles</dt>
            <dd>
              {me.roles.length === 0 ? '—' : (
                <ul className="flex flex-col gap-0.5">
                  {me.roles.map((r) => (
                    <li key={`${r.roleName}-${r.branchName ?? 'all'}`}>
                      {r.roleName}<span className="text-muted-foreground"> · {r.branchName ?? 'all branches'}</span>
                    </li>
                  ))}
                </ul>
              )}
            </dd>
          </dl>
        </div>
      )}
    </div>
  );
}
