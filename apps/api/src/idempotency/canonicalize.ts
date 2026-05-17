import { createHash } from 'node:crypto';

/**
 * Deterministic JSON-ish serialization for hashing. Same input value
 * produces the same string regardless of object key order. We avoid
 * JSON.stringify because its key order is implementation-dependent
 * in some cases, and we want explicit control over what hashes the
 * same and what does not.
 *
 * Limitations: BigInt is rendered via toString() with an 'n' marker.
 * Date is rendered via toISOString(). undefined collapses to null
 * (matches JSON semantics). Functions, symbols, and other unsupported
 * types throw.
 */
export function canonicalize(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'bigint') return `"${value.toString()}n"`;
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    throw new Error(`cannot canonicalize value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

/**
 * Hash of method + path + canonicalized body. The hash is what we
 * compare against the stored request_hash to decide replay vs conflict.
 */
export function requestHash(method: string, path: string, body: unknown): string {
  const input = `${method.toUpperCase()} ${path}\n${canonicalize(body)}`;
  return createHash('sha256').update(input).digest('hex');
}
