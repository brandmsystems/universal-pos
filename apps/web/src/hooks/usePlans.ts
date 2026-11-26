import { useEffect, useState } from 'react';
import type { PlatformApi } from '../services/platformApi.js';
import type { Plan } from '../types/restaurant.js';
import { standardPlans } from '../lib/plans.js';

/** The plan catalogue, read once per screen. An empty list if it cannot be read. */
export function usePlans(api: PlatformApi): readonly Plan[] {
  const [plans, setPlans] = useState<readonly Plan[]>([]);
  useEffect(() => {
    let live = true;
    void (async () => {
      try {
        const read = await api.get<readonly Plan[]>('/plans');
        if (live) setPlans(standardPlans(read));
      } catch {
        if (live) setPlans([]);
      }
    })();
    return () => { live = false; };
  }, [api]);
  return plans;
}
