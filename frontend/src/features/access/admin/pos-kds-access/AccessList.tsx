import type { ReactElement } from 'react';
import { Badge } from '@/components/ui/badge.js';
import type { AccessAccount } from './api.js';

function when(value: string | null): string {
  if (value === null) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/**
 * Who can sign in and how -- read only. Staff sign in on the till with their
 * name and a 4-digit PIN; managers with email and password. Adding staff,
 * setting a PIN and switching someone off are the Sales person's.
 */
export function AccessList(props: { accounts: readonly AccessAccount[] }): ReactElement {
  if (props.accounts.length === 0) {
    return <p className="text-sm text-muted-foreground">Nobody has access yet. Your Sales person adds staff.</p>;
  }
  return (
    <div className="overflow-x-auto rounded-[4px] border border-border bg-card">
      <table className="w-full text-sm">
        <thead>
          <tr className="border-b-2 border-border text-left text-xs font-bold uppercase tracking-wider text-muted-foreground">
            <th className="px-3 py-2.5">Name</th>
            <th className="px-3 py-2.5">Signs in with</th>
            <th className="px-3 py-2.5">Roles</th>
            <th className="px-3 py-2.5">Can use</th>
            <th className="px-3 py-2.5">Last sign-in</th>
            <th className="px-3 py-2.5">Status</th>
          </tr>
        </thead>
        <tbody>
          {props.accounts.map((account) => {
            const active = account.status === 'active';
            return (
              <tr key={account.userId} className={`border-b border-border last:border-b-0 ${active ? '' : 'opacity-60'}`}>
                <td className="px-3 py-2.5 font-semibold">{account.fullName}</td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {account.hasPassword && <Badge variant="secondary">Email &amp; password</Badge>}
                    {account.hasPin && <Badge variant="secondary">PIN</Badge>}
                    {!account.hasPassword && !account.hasPin && <Badge variant="outline">no PIN yet</Badge>}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {account.roles.map((role) => (
                      <Badge key={`${role.roleKey}-${role.branchName ?? 'all'}`} variant="secondary">
                        {role.roleName}{role.branchName ? ` · ${role.branchName}` : ''}
                      </Badge>
                    ))}
                  </div>
                </td>
                <td className="px-3 py-2.5">
                  <div className="flex flex-wrap gap-1">
                    {account.kotAccess && <Badge variant="outline">KOT</Badge>}
                    {account.billingAccess && <Badge variant="outline">Billing</Badge>}
                    {!account.kotAccess && !account.billingAccess
                      && <span className="text-muted-foreground">Manager screens</span>}
                  </div>
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-xs text-muted-foreground">{when(account.lastSignInAt)}</td>
                <td className="px-3 py-2.5">{active ? 'Active' : 'Switched off'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
