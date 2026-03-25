import { hash } from './hash.js';
import type { ActionObject } from './types.js';

/**
 * Derive a cache key for an action based on its stable identity
 * and declared dependency ids.
 *
 * Cache key includes:
 * - actionKind
 * - declared inputs (objectIds, in order)
 * - effectful flag
 * - stable properties that affect output
 */
export function deriveCacheKey(
  action: ActionObject,
  dependencyHashes: string[],
): string {
  return hash({
    actionKind: action.actionKind,
    declaredInputIds: action.declared.inputs.map((d) => d.objectId),
    dependencyHashes,
    effectful: action.effectful,
    type: action.type,
    properties: action.properties,
  } as Record<string, unknown>);
}
