import { useEffect, useState } from 'react';
import type { PlatformApi } from '../services/platformApi.js';
import type { Profile } from '../types/profile.js';

/** The signed-in account from `GET /me`; null until it arrives or if it cannot be read. */
export function useProfile(api: PlatformApi, subject: string | null): Profile | null {
  const [profile, setProfile] = useState<Profile | null>(null);
  useEffect(() => {
    setProfile(null);
    if (subject === null) return;
    let live = true;
    void (async () => {
      try {
        const me = await api.get<Profile>('/me');
        if (live) setProfile(me);
      } catch {
        if (live) setProfile(null);
      }
    })();
    return () => { live = false; };
  }, [api, subject]);
  return profile;
}
