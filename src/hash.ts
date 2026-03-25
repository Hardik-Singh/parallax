import { blake3 } from '@noble/hashes/blake3.js';
import { bytesToHex } from '@noble/hashes/utils.js';

/**
 * Canonicalize a value for deterministic JSON serialization.
 *
 * Rules:
 * - Objects: recursively sort keys, omit undefined values
 * - Arrays: preserve order, canonicalize each element
 * - Primitives: pass through as-is
 */
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }

  if (typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) {
        sorted[key] = canonicalize(v);
      }
    }
    return sorted;
  }

  return value;
}

/**
 * Deterministic BLAKE3 hash of any JSON-serializable content.
 * Canonical serialization ensures identical content always produces the same hash
 * regardless of original key insertion order.
 */
export function hash(content: Record<string, unknown>): string {
  const canonical = canonicalize(content);
  const json = JSON.stringify(canonical);
  const encoder = new TextEncoder();
  return bytesToHex(blake3(encoder.encode(json)));
}
