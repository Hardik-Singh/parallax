import { describe, it, expect } from 'vitest';
import { hash, canonicalize } from '../src/hash.js';

describe('canonical hashing', () => {
  it('produces identical hash regardless of key insertion order', () => {
    const a = { z: 1, a: 2, m: 3 };
    const b = { a: 2, m: 3, z: 1 };
    expect(hash(a)).toBe(hash(b));
  });

  it('handles nested objects deterministically', () => {
    const a = { outer: { z: 1, a: 2 }, list: [1, 2, 3] };
    const b = { list: [1, 2, 3], outer: { a: 2, z: 1 } };
    expect(hash(a)).toBe(hash(b));
  });

  it('strips undefined values', () => {
    const a = { x: 1, y: undefined };
    const b = { x: 1 };
    expect(hash(a as Record<string, unknown>)).toBe(hash(b));
  });

  it('preserves array order', () => {
    const a = { items: [1, 2, 3] };
    const b = { items: [3, 2, 1] };
    expect(hash(a)).not.toBe(hash(b));
  });

  it('different content produces different hashes', () => {
    const a = { x: 1 };
    const b = { x: 2 };
    expect(hash(a)).not.toBe(hash(b));
  });
});
