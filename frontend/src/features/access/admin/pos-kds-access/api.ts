import type { Api } from '../../../../services/api.js';

export interface AccessAccount {
  readonly userId: string;
  readonly fullName: string;
  readonly email: string | null;
  readonly employeeCode: string | null;
  readonly status: string;
  readonly hasPin: boolean;
  readonly hasPassword: boolean;
  readonly lastSignInAt: string | null;
  readonly pendingReset: readonly ('pin' | 'password')[];
  readonly roles: readonly { roleKey: string; roleName: string; branchName: string | null }[];
  /** Derived server-side from the keys the person's roles hold. */
  readonly kotAccess: boolean;
  readonly billingAccess: boolean;
  readonly kitchenAccess: boolean;
}

/** Read only: staff PINs, adding and switching off are the Sales person's. */
export const listAccess = (api: Api): Promise<AccessAccount[]> => api.get<AccessAccount[]>('/admin/access');
