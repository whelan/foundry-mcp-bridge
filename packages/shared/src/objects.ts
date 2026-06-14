/**
 * Plain-object utilities shared by the scene builders, the mock-foundry and the
 * MCP server's reliability pipeline. Mirrors Foundry's expandObject / update
 * merge semantics so behaviour is identical on both ends.
 */

export type Json = Record<string, unknown>;

export function isPlainObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Deep-merge `override` into `base` (override wins; arrays are replaced). */
export function deepMerge<T extends Json>(base: T, override?: Json): T {
  if (!override) return base;
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = out[key];
    if (isPlainObject(existing) && isPlainObject(value)) {
      out[key] = deepMerge(existing, value);
    } else {
      out[key] = value;
    }
  }
  return out as T;
}

/** Foundry expandObject: {"a.b": 1} -> {a:{b:1}}. */
export function expandObject(flat: Json): Json {
  const out: Json = {};
  for (const [path, value] of Object.entries(flat)) {
    const parts = path.split(".");
    let cursor = out;
    for (let i = 0; i < parts.length - 1; i++) {
      const key = parts[i]!;
      if (!isPlainObject(cursor[key])) cursor[key] = {};
      cursor = cursor[key] as Json;
    }
    cursor[parts[parts.length - 1]!] = value;
  }
  return out;
}

/** Read a value by dot path. */
export function getByPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, key) => {
    if (isPlainObject(acc)) return acc[key];
    return undefined;
  }, obj);
}

/** Apply a Foundry update diff (dot-notation aware) to a clone of `doc`. */
export function applyUpdate(doc: Json, diff: Json): Json {
  return deepMerge(structuredClone(doc), expandObject(diff));
}

/**
 * True when every (possibly nested) leaf in `expected` is present and equal in
 * `actual`. Used for read-back verification: we only assert the fields we sent,
 * not the fields Foundry adds. Arrays are compared by deep equality.
 */
export function isSubset(actual: unknown, expected: unknown): boolean {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.entries(expected).every(([k, v]) => isSubset(actual[k], v));
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((v, i) => isSubset(actual[i], v));
  }
  return Object.is(actual, expected);
}
