import type { ParallaxStore } from './store.js';
import type { ActionObject, BaseObject, DependencySpec } from './types.js';

/**
 * Resolve scoped context for an action based on its declared.inputs.
 *
 * Semantics:
 * - Resolve exactly the objects listed in declared.inputs
 * - Apply `select` field filtering when present
 * - Namespace under `alias` when present
 * - Throw on key collisions
 * - Never expose undeclared upstream objects
 *
 * Context materialization: for each dependency, we expose the object's
 * `properties` field. For Artifacts, we expose `content` instead.
 */
export async function resolveScopedContext(
  store: ParallaxStore,
  action: ActionObject,
): Promise<Record<string, unknown>> {
  const context: Record<string, unknown> = {};

  for (const dep of action.declared.inputs) {
    const obj = await store.getObject(dep.objectId);
    if (!obj) {
      throw new Error(
        `Declared dependency ${dep.objectId} not found for action ${action.id}`,
      );
    }

    // Materialize the object's data
    let data: Record<string, unknown>;
    if (obj.kind === 'Artifact') {
      data = { ...(obj as unknown as { content: Record<string, unknown> }).content };
    } else {
      data = { ...obj.properties };
    }

    // Apply select filtering
    if (dep.select && dep.select.length > 0) {
      const filtered: Record<string, unknown> = {};
      for (const field of dep.select) {
        if (field in data) {
          filtered[field] = data[field];
        }
      }
      data = filtered;
    }

    // Apply alias namespacing or merge into context
    if (dep.alias) {
      if (dep.alias in context) {
        throw new Error(
          `Key collision in scoped context: alias "${dep.alias}" already exists`,
        );
      }
      context[dep.alias] = data;
    } else {
      // Merge keys directly, checking for collisions
      for (const [key, value] of Object.entries(data)) {
        if (key in context) {
          throw new Error(
            `Key collision in scoped context: key "${key}" from dependency ${dep.objectId} conflicts with existing key`,
          );
        }
        context[key] = value;
      }
    }
  }

  return context;
}
