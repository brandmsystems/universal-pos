import type { ReactElement } from 'react';
import type { PlatformApi } from '../../../services/platformApi.js';
import { RestaurantManager, type RestaurantPermissions } from './RestaurantManager.js';

/**
 * Every restaurant on the platform, for the Super Admin and the roles that
 * support the estate. The list, filters and dialogs are `RestaurantManager`,
 * shared with the Salesperson's own dashboard.
 */
export function Restaurants(props: { api: PlatformApi; can: RestaurantPermissions }): ReactElement {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-xl font-bold tracking-tight text-foreground sm:text-2xl">Restaurants</span>
        <span className="max-w-[680px] text-sm leading-relaxed text-muted-foreground">
          Every restaurant on the platform, newest first, with who sold it, what it
          is on and when that runs out.
        </span>
      </div>
      <RestaurantManager api={props.api} mode="estate" can={props.can} />
    </div>
  );
}
