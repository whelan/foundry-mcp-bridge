/**
 * Autorun macros (GM): on login, the active GM's browser runs the world macros named in the
 * setting, in order, each with `{ autostart: true }` (the vault's Rejseleder installs its
 * travel watcher this way and opens no panel).
 *
 * This is not code execution on the bridge's behalf: it runs the GM's own world macros in the
 * GM's own browser on the GM's own login, so it is not gated by "Allow the bridge to run macros".
 *
 * Only the active GM runs the list, so two GMs logged in never start a watcher twice. When the
 * active GM changes (the first GM leaves, another stays), the new active GM's browser runs it.
 * A flag on `globalThis` keeps one browser from running it twice.
 *
 * `runAutorun` reads only the `game`-shaped object and the notifier it is handed, so it is
 * unit-tested with plain objects.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

export const DEFAULT_AUTORUN_MACROS = "Rejseleder";
export const AUTORUN_FLAG = "__whelanMcpBridgeAutorunDone";

export interface AutorunDeps {
  game: any;
  warn: (message: string) => void;
  log: (message: string) => void;
  /** Where the once-per-browser flag lives; `globalThis` in Foundry. */
  store?: Record<string, unknown>;
}

export interface AutorunResult {
  name: string;
  ok: boolean;
  result: string;
}

/** Comma-separated names to a clean list; empty entries dropped. */
export function parseAutorunList(value: unknown): string[] {
  return String(value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

const describe = (v: unknown): string => {
  if (v === undefined) return "done";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
};

/**
 * Run the list once in this browser if this user is the active GM. Returns what ran, or
 * `null` when this browser is not the one to run it (not the active GM, or already ran).
 * Never throws: every failure is a console line and one warning naming the macro.
 */
export async function runAutorun(names: string[], deps: AutorunDeps): Promise<AutorunResult[] | null> {
  const { game, warn, log } = deps;
  const store = deps.store ?? (globalThis as unknown as Record<string, unknown>);
  const me = game?.user;
  if (!me?.isGM) return null;
  const active = game.users?.activeGM;
  if (!active || active.id !== me.id) return null;
  if (store[AUTORUN_FLAG]) return null;
  store[AUTORUN_FLAG] = true;

  const results: AutorunResult[] = [];
  for (const name of names) {
    let ok = false;
    let result: string;
    try {
      const macro = game.macros?.getName?.(name);
      if (!macro) result = "no macro with that name";
      else if (macro.canExecute === false) result = "the GM cannot execute it";
      else {
        result = describe(await macro.execute({ autostart: true }));
        ok = true;
      }
    } catch (e) {
      result = `threw: ${(e as Error)?.message ?? String(e)}`;
    }
    log(`[bridge] autorun ${name}: ${result}`);
    if (!ok) warn(`Autorun: the macro "${name}" did not run (${result}).`);
    results.push({ name, ok, result });
  }
  return results;
}
