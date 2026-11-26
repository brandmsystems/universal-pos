/**
 * ###########################################################################
 * THE ONLY PLACE IN THE CLIENT THAT TOUCHES BROWSER STORAGE.
 *
 * The POS is a PWA, so this guarantee is CONDITIONAL and the condition is named
 * rather than hidden: browser storage can be evicted under pressure. A tablet
 * whose persistence request was refused is a tablet whose drafts are at risk,
 * and it has to be able to say so instead of discovering it during a service.
 *
 * One adapter also makes a native shell a replaceable dependency rather than a
 * rewrite -- and it is what the import gate enforces: no screen may reach for
 * localStorage, indexedDB or caches directly.
 * ###########################################################################
 */

export type Durability = 'persistent' | 'best-effort' | 'unavailable';

export interface Store {
  readonly durability: Durability;
  /**
   * Told whenever the browser's answer changes `durability`. The answer arrives
   * AFTER the first render, so a screen that read `durability` once would keep a
   * stale warning up for the whole service. Returns the unsubscribe.
   */
  onDurabilityChange(listener: (durability: Durability) => void): () => void;
  /**
   * Ask the browser again -- from a tap, because some browsers only grant (or
   * only prompt) on a user gesture. Resolves to the recorded answer; a refusal or
   * an unsupported browser leaves `best-effort`, never throws.
   */
  requestPersistence(): Promise<Durability>;
  get<T>(key: string): T | null;
  set<T>(key: string, value: T): boolean;
  remove(key: string): void;
  /** Every key this store holds, as its callers name them. */
  keys(): string[];
}

const PREFIX = 'kk.';

/**
 * Every read and write is wrapped.
 *
 * A private window, cleared site data, or a browser set to block site data all
 * make the accessor itself throw -- and a POS that white-screens because it
 * could not read a cached preference is worse than one that forgets the
 * preference.
 */
function safeLocal(): Storage | null {
  try {
    const probe = `${PREFIX}__probe`;
    window.localStorage.setItem(probe, '1');
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return null;
  }
}

let cached: Store | null = null;

export function createStore(): Store {
  if (cached) return cached;

  const backing = safeLocal();
  const memory = new Map<string, string>();

  const durability = trackDurability(backing !== null,
    typeof navigator !== 'undefined' && navigator.storage ? navigator.storage : null);

  const store: Store = {
    get durability() {
      return durability.current();
    },
    onDurabilityChange: durability.onChange,
    requestPersistence: durability.ask,
    get<T>(key: string): T | null {
      const raw = backing ? tryGet(backing, PREFIX + key) : memory.get(PREFIX + key) ?? null;
      if (raw === null) return null;
      try {
        return JSON.parse(raw) as T;
      } catch {
        // Corrupt entry: drop it rather than crash on every boot from here on.
        store.remove(key);
        return null;
      }
    },
    set<T>(key: string, value: T): boolean {
      const raw = JSON.stringify(value);
      if (!backing) {
        memory.set(PREFIX + key, raw);
        return false; // in memory only, and the caller is told
      }
      try {
        backing.setItem(PREFIX + key, raw);
        return true;
      } catch {
        // Quota. The queue's cap exists so this is rare, and a silent failure
        // here would be a draft the waiter believes is safe.
        memory.set(PREFIX + key, raw);
        return false;
      }
    },
    keys(): string[] {
      const found = new Set<string>();
      if (backing) {
        try {
          for (let i = 0; i < backing.length; i++) {
            const name = backing.key(i);
            if (name !== null && name.startsWith(PREFIX) && !name.startsWith(`${PREFIX}__`)) found.add(name.slice(PREFIX.length));
          }
        } catch {
          /* unreadable storage lists nothing */
        }
      }
      for (const name of memory.keys()) found.add(name.slice(PREFIX.length));
      return [...found];
    },
    remove(key: string): void {
      if (backing) {
        try {
          backing.removeItem(PREFIX + key);
        } catch {
          /* nothing to recover */
        }
      }
      memory.delete(PREFIX + key);
    },
  };

  cached = store;
  return store;
}

/**
 * Whether this browser has promised not to evict the till's storage.
 *
 * Asked at first run, and the ANSWER IS RECORDED -- and announced, because it
 * arrives after the first render. Requesting it and ignoring the result is how
 * the draft guarantee becomes a hope. `persisted()` first: a till granted on an
 * earlier visit is persistent without asking again. A refusal, a missing API or
 * a throwing one all leave `best-effort` and the warning up; nothing stored is
 * touched either way -- this changes what the till SAYS, never what it keeps.
 */
export function trackDurability(available: boolean, manager: Pick<StorageManager, 'persist' | 'persisted'> | null): {
  current: () => Durability;
  onChange: (listener: (d: Durability) => void) => () => void;
  ask: () => Promise<Durability>;
} {
  let durability: Durability = available ? 'best-effort' : 'unavailable';
  const listeners = new Set<(d: Durability) => void>();
  const record = (granted: boolean): Durability => {
    const next: Durability = granted ? 'persistent' : 'best-effort';
    if (next !== durability) {
      durability = next;
      for (const listener of listeners) listener(next);
    }
    return durability;
  };
  async function ask(): Promise<Durability> {
    if (!available || manager === null) return durability;
    try {
      if (typeof manager.persisted === 'function' && await manager.persisted()) return record(true);
      if (typeof manager.persist !== 'function') return durability;
      return record(await manager.persist());
    } catch {
      return durability;
    }
  }
  void ask();
  return {
    current: () => durability,
    onChange: (listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    ask,
  };
}

function tryGet(backing: Storage, key: string): string | null {
  try {
    return backing.getItem(key);
  } catch {
    return null;
  }
}

/**
 * The same store with every key under `scope:`. The POS and the KDS scope by
 * app and restaurant, so a browser set up as one restaurant's tablet can never
 * open as another's, and one browser can be a tablet for several.
 */
export function scopedStore(store: Store, scope: string): Store {
  const key = (name: string): string => `${scope}:${name}`;
  return {
    get durability() {
      return store.durability;
    },
    onDurabilityChange: (listener) => store.onDurabilityChange(listener),
    requestPersistence: () => store.requestPersistence(),
    get: <T>(name: string): T | null => store.get<T>(key(name)),
    set: <T>(name: string, value: T): boolean => store.set(key(name), value),
    remove: (name: string): void => store.remove(key(name)),
    keys: (): string[] => store.keys()
      .filter((name) => name.startsWith(`${scope}:`)).map((name) => name.slice(scope.length + 1)),
  };
}

/**
 * A restaurant's address changed (a Super Admin renamed its slug). Everything
 * this browser keeps under the OLD slug -- a tablet's identity, its sign-in,
 * its queue and leases, under `pos:`, `kds:` and `billing:` -- moves to the new
 * one, and every stored record that names the old slug (`tenantSlug`) is
 * updated, the admin's sign-in included. Without this a renamed restaurant's
 * tablets would all open on "Set up this tablet".
 *
 * Safe to call more than once: nothing is left under the old slug to move.
 */
export function moveRestaurantStorage(oldSlug: string, newSlug: string): void {
  if (oldSlug === newSlug) return;
  const store = createStore();
  for (const name of store.keys()) {
    const scope = /^(pos|kds|billing):([^:]+)(:.*)$/.exec(name);
    const target = scope !== null && scope[2] === oldSlug ? `${scope[1]}:${newSlug}${scope[3]}` : name;
    const value = store.get<unknown>(name);
    const renamed = value !== null && typeof value === 'object' && (value as { tenantSlug?: unknown }).tenantSlug === oldSlug
      ? { ...(value as object), tenantSlug: newSlug } : value;
    if (target === name && renamed === value) continue;
    store.set(target, renamed);
    if (target !== name) store.remove(name);
  }
}
