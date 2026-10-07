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

/**
 * Path segments that would let a dot-path reach an object's prototype chain.
 * Dot-paths here are user/LLM-controlled (update diffs, field projections), so a
 * path like "__proto__.polluted" must never walk into Object.prototype.
 */
const UNSAFE_KEYS = new Set(["__proto__", "prototype", "constructor"]);

/**
 * True when a dot-path is a well-formed, safe key path: no segment escapes to the
 * prototype chain, and no segment is empty (e.g. "a..b" or ".x" would create an
 * empty-string key — almost certainly invalid input).
 */
export function isSafePath(path: string): boolean {
  return path.split(".").every((seg) => seg !== "" && !UNSAFE_KEYS.has(seg));
}

/** Drop top-level keys whose dot-path is unsafe (prototype-chain or malformed). */
export function filterUnsafePaths(record: Json): Json {
  const out: Json = {};
  for (const [key, value] of Object.entries(record)) {
    if (isSafePath(key)) out[key] = value;
  }
  return out;
}

/** Foundry expandObject: {"a.b": 1} -> {a:{b:1}}. Paths touching prototype keys are skipped. */
export function expandObject(flat: Json): Json {
  const out: Json = {};
  for (const [path, value] of Object.entries(flat)) {
    if (!isSafePath(path)) continue; // drop prototype-pollution attempts
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

/** Foundry's deletion marker: `{"-=key": null}` (or `"a.b.-=key": null`) removes `key` on update. */
const REMOVAL = "-=";

/** Merge an expanded update into `base`, honouring `-=key: null` deletions at any depth. */
function mergeUpdate(base: Json, patch: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (key.startsWith(REMOVAL) && value === null) {
      delete out[key.slice(REMOVAL.length)];
    } else if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = mergeUpdate(out[key] as Json, value);
    } else if (isPlainObject(value)) {
      out[key] = mergeUpdate({}, value);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/** Apply a Foundry update diff (dot-notation and `-=` deletions aware) to a clone of `doc`. */
export function applyUpdate(doc: Json, diff: Json): Json {
  return mergeUpdate(structuredClone(doc), expandObject(diff));
}

/**
 * Split an update diff into what it sets and the dot-paths it deletes (`-=key: null`), so
 * read-back can assert presence of the former and *absence* of the latter.
 */
export function splitRemovals(diff: Json): { set: Json; removed: string[] } {
  const removed: string[] = [];
  const walk = (node: Json, prefix: string[]): Json => {
    const out: Json = {};
    for (const [key, value] of Object.entries(node)) {
      if (key.startsWith(REMOVAL) && value === null) {
        removed.push([...prefix, key.slice(REMOVAL.length)].join("."));
      } else if (isPlainObject(value)) {
        const child = walk(value, [...prefix, key]);
        if (Object.keys(child).length > 0 || Object.keys(value).length === 0) out[key] = child;
      } else {
        out[key] = value;
      }
    }
    return out;
  };
  return { set: walk(expandObject(diff), []), removed };
}

/** True when `path` does not exist in `doc` (an explicit `null` still exists). */
export function isAbsent(doc: unknown, path: string): boolean {
  return getByPath(doc, path) === undefined;
}

/** Every leaf dot-path of an expanded object; arrays, primitives and empty objects are leaves. */
function leafPaths(node: Json, prefix: string[] = []): string[][] {
  return Object.entries(node).flatMap(([key, value]) =>
    isPlainObject(value) && Object.keys(value).length > 0 ? leafPaths(value, [...prefix, key]) : [[...prefix, key]],
  );
}

/**
 * The update that reverses `diff` on a document that looked like `before`. Unlike restoring
 * `before[key] ?? null`, it tells "was absent" from "was null": values that existed are put
 * back, and fields the diff added are deleted with `-=` (at the shallowest ancestor that did
 * not exist, so no empty containers are left behind). Deletions in `diff` are restored too.
 */
export function buildInverseUpdate(before: Json, diff: Json): Json {
  const { set, removed } = splitRemovals(diff);
  const paths = [...leafPaths(set), ...removed.map((p) => p.split("."))];
  const inverse: Json = {};
  for (const parts of paths) {
    const previous = getByPath(before, parts.join("."));
    if (previous !== undefined) {
      inverse[parts.join(".")] = previous;
      continue;
    }
    // Absent before: delete at the first missing segment.
    let cursor: unknown = before;
    let i = 0;
    for (; i < parts.length; i++) {
      if (!isPlainObject(cursor) || cursor[parts[i]!] === undefined) break;
      cursor = (cursor as Json)[parts[i]!];
    }
    if (i < parts.length) inverse[[...parts.slice(0, i), `${REMOVAL}${parts[i]}`].join(".")] = null;
  }
  return inverse;
}

/**
 * True when every (possibly nested) leaf in `expected` is present and equal in
 * `actual`. Used for read-back verification: we only assert the fields we sent,
 * not the fields Foundry adds. Arrays are compared by deep equality.
 *
 * Keys whose `expected` value is `undefined` are skipped: `undefined` never
 * survives JSON serialization over the wire, so it was never actually sent and
 * cannot be asserted against a read-back (which Foundry may populate with a real
 * default, e.g. `img`/`prototypeToken` on a freshly created actor).
 */
export function isSubset(actual: unknown, expected: unknown): boolean {
  if (isPlainObject(expected)) {
    if (!isPlainObject(actual)) return false;
    return Object.entries(expected).every(
      ([k, v]) => v === undefined || isSubset(actual[k], v),
    );
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual) || actual.length !== expected.length) return false;
    return expected.every((v, i) => isSubset(actual[i], v));
  }
  return Object.is(actual, expected);
}
