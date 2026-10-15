/**
 * Builders for dnd5e Activities (dnd5e 3.0+ / verified against 5.3.3).
 *
 * Shapes are copied from real documents in test/fixtures/dnd5e-605-schema/
 * (see its README): attack follows rotting-touch-weapon.json (flat bonus),
 * save follows Cold Breath in white-dragon-wyrmling-full.json, utility
 * follows Multiattack in the same file. Do not invent fields — if a shape
 * question comes up, answer it from the fixtures.
 */

import { randomID } from "@foundry-mcp-bridge/shared";
import type { DamagePart as GrammarDamagePart } from "./grammar.js";
import { parseDamageFormula } from "./math.js";

/** Random 16-char Foundry document id. */
export const foundryId = randomID;

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/**
 * Deterministic 16-char Foundry-style id derived from a stable seed (e.g. an
 * item's own statblockKey). Re-synthesizing the same statblock content must
 * produce byte-identical activity ids so a re-import with no real changes is
 * a true no-op — a random id here made every re-import look "changed" even
 * when nothing was edited, since the activity dict's own key differed each
 * time (see import-npc.ts's diffAndApplyItems).
 */
export function stableId(seed: string): string {
  let h = 0x811c9dc5;
  const chars: string[] = [];
  let cursor = seed;
  while (chars.length < 16) {
    for (let i = 0; i < cursor.length; i++) {
      h ^= cursor.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    h = h >>> 0;
    for (let i = 0; i < 4 && chars.length < 16; i++) {
      chars.push(ID_CHARS[(h >>> (i * 8)) % ID_CHARS.length]!);
    }
    cursor = `${seed}#${chars.length}`; // perturb so successive rounds differ
  }
  return chars.join("");
}

/** dnd5e structured damage part (used for damage.base and activity damage.parts). */
export interface ActivityDamagePart {
  number: number;
  denomination: number;
  bonus: string;
  types: string[];
  custom: { enabled: boolean; formula: string };
  scaling: { number: number };
}

export function toDamagePart(part: Pick<GrammarDamagePart, "formula" | "type">): ActivityDamagePart {
  const f = parseDamageFormula(part.formula);
  return {
    number: f.count,
    denomination: f.die,
    bonus: f.bonus !== 0 ? String(f.bonus) : "",
    types: [part.type],
    custom: { enabled: false, formula: "" },
    scaling: { number: 1 },
  };
}

export interface AreaTemplate {
  type: string; // "cone" | "line" | "sphere" | "radius" | "emanation" | "cube" | "cylinder"
  size: string;
}

/** Extract "15-foot cone" style templates from an action description. */
export function parseTemplate(description: string): AreaTemplate | undefined {
  const m = description.match(/(\d+)-foot\s+(cone|line|sphere|radius|emanation|cube|cylinder)/i);
  if (!m) return undefined;
  return { type: m[2]!.toLowerCase(), size: m[1]! };
}

/**
 * dnd5e's activation-type enum (CONFIG.DND5E.activityActivationTypes)
 * includes "legendary"/"lair" alongside "action"/"reaction"; none of our
 * committed fixtures (test/fixtures/dnd5e-605-schema/) include a legendary or
 * lair action, so this pairing isn't fixture-verified the way the rest of
 * this file is — confirm against a live world in M6b if a legendary-action
 * statblock is imported.
 */
export type ActivationType = "action" | "reaction" | "legendary" | "lair" | "";

// The boilerplate every activity carries, kept to the *minimal* key set that
// appears in ALL official examples (the compendium strips schema defaults, so
// e.g. Ghast's Claw attack activity has no activation.condition while Rotting
// Touch's does — emitting only the common denominator keeps us a key-subset
// of every official document). saveActivity adds the save-specific extras.
function activityCommon(id: string, activation: ActivationType) {
  return {
    _id: id,
    sort: 0,
    activation: { type: activation, value: null, override: false },
    consumption: { scaling: { allowed: false }, spellSlot: true, targets: [] as unknown[] },
    description: {},
    duration: { units: "inst", concentration: false, override: false },
    effects: [] as unknown[],
    range: { override: false, units: "self" },
    target: {
      template: { contiguous: false, units: "ft" },
      affects: { choice: false },
      override: false,
      prompt: true,
    },
    uses: { spent: 0, recovery: [] as unknown[] },
    img: null as string | null,
    flags: {},
    visibility: {
      level: {},
      requireAttunement: false,
      requireIdentification: false,
      requireMagic: false,
    },
  };
}

export type Activities = Record<string, Record<string, unknown>>;

export interface AttackActivityOptions {
  id?: string;
  /** Total to-hit bonus as printed on the statblock (mods already included). */
  bonus: number;
  attackType: "melee" | "ranged";
  /** Damage beyond damage.base — e.g. the "plus 3 (1d6) Necrotic" part. */
  extraParts?: ActivityDamagePart[];
  activation?: ActivationType;
  /** True when the item has recharge uses this activity should consume. */
  consumesItemUse?: boolean;
}

export function attackActivity(opts: AttackActivityOptions): Activities {
  const id = opts.id ?? foundryId();
  const common = activityCommon(id, opts.activation ?? "action");
  return {
    [id]: {
      ...common,
      type: "attack",
      attack: {
        critical: { threshold: null },
        // flat + ability "none": reproduce the printed to-hit exactly and add
        // no ability mod to base damage (its explicit bonus carries the mod).
        flat: true,
        ability: "none",
        bonus: String(opts.bonus),
        type: { value: opts.attackType, classification: "" },
      },
      damage: { critical: { bonus: "" }, includeBase: true, parts: opts.extraParts ?? [] },
      consumption: {
        ...common.consumption,
        targets: opts.consumesItemUse
          ? [{ type: "itemUses", value: "1", target: "", scaling: {} }]
          : [],
      },
    },
  };
}

export interface SaveActivityOptions {
  id?: string;
  /** Three-letter ability key, e.g. "con". */
  ability: string;
  dc: number;
  parts: ActivityDamagePart[];
  onSave: "half" | "none";
  template?: AreaTemplate;
  /** True when the item has recharge uses this activity should consume. */
  consumesItemUse?: boolean;
  activation?: ActivationType;
}

export function saveActivity(opts: SaveActivityOptions): Activities {
  const id = opts.id ?? foundryId();
  const common = activityCommon(id, opts.activation ?? "action");
  return {
    [id]: {
      ...common,
      type: "save",
      // Save activities carry keys the other kinds don't (fixture-proven on
      // Stench / Cold Breath): activation.condition, description.chatFlavor,
      // range.special, a full target template, uses.max.
      activation: { ...common.activation, condition: "" },
      description: { chatFlavor: "" },
      range: { ...common.range, special: "" },
      target: {
        ...common.target,
        template: {
          ...common.target.template,
          type: opts.template?.type ?? "",
          size: opts.template?.size ?? "",
          count: "",
        },
        affects: { ...common.target.affects, type: opts.template ? "creature" : "", count: "", special: "" },
      },
      uses: { ...common.uses, max: "" },
      consumption: {
        ...common.consumption,
        targets: opts.consumesItemUse
          ? [{ type: "itemUses", value: "1", target: "", scaling: {} }]
          : [],
      },
      // Empty calculation = "use the formula as the flat DC" (fixture-proven).
      save: { ability: [opts.ability], dc: { calculation: "", formula: String(opts.dc) } },
      damage: { parts: opts.parts, onSave: opts.onSave },
    },
  };
}

export interface UtilityActivityOptions {
  id?: string;
  activation: ActivationType;
}

export function utilityActivity(opts: UtilityActivityOptions): Activities {
  const id = opts.id ?? foundryId();
  return {
    [id]: {
      ...activityCommon(id, opts.activation),
      type: "utility",
      roll: { prompt: false, visible: false },
    },
  };
}
