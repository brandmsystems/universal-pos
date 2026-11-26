import type pg from 'pg';
import type { RouteDeps } from './routeRegistry.js';
import { recordUnattributable } from '../../jobs/unattributable.js';

/**
 * The production composition root for route dependencies.
 *
 * `resolveActor` is deliberately ABSENT rather than set to the real function:
 * the registry falls back to the real resolver, so there is no configuration
 * point here to get wrong. A test asserts this object never carries the key --
 * otherwise the test seam would be a configurable hole in the attribution path.
 */
export function productionRouteDeps(pool: pg.Pool): RouteDeps {
  return {
    pool,
    onUnattributable: recordUnattributable,
  };
}
