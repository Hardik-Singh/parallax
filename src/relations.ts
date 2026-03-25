import type { ParallaxStore } from './store.js';
import type { Relation, RelationType } from './types.js';
import { hash } from './hash.js';

/**
 * Create a deterministic relation id from its stable fields.
 */
export function relationId(type: RelationType, from: string, to: string): string {
  return hash({ type, from, to } as Record<string, unknown>);
}

/**
 * Validate that adding a DEPENDS_ON relation would not create a cycle.
 * Performs a DFS from `to` following DEPENDS_ON edges to check if `from`
 * is reachable — which would mean from -> to creates a cycle.
 */
export async function validateNoCycle(
  store: ParallaxStore,
  from: string,
  to: string,
): Promise<void> {
  // If from === to, trivially a cycle
  if (from === to) {
    throw new Error(`Dependency cycle detected: ${from} -> ${to}`);
  }

  const visited = new Set<string>();
  const stack = [to];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === from) {
      throw new Error(
        `Dependency cycle detected: adding ${from} -> ${to} would create a cycle`,
      );
    }
    if (visited.has(current)) continue;
    visited.add(current);

    // Follow DEPENDS_ON edges outward from current
    const deps = await store.getRelations('DEPENDS_ON', current);
    for (const dep of deps) {
      stack.push(dep.to);
    }
  }
}

/**
 * Validate that both endpoints of a relation exist in the store.
 */
export async function validateEndpoints(
  store: ParallaxStore,
  from: string,
  to: string,
): Promise<void> {
  const [fromObj, toObj] = await Promise.all([
    store.getObject(from),
    store.getObject(to),
  ]);
  if (!fromObj) {
    throw new Error(`Relation endpoint not found: ${from}`);
  }
  if (!toObj) {
    throw new Error(`Relation endpoint not found: ${to}`);
  }
}
