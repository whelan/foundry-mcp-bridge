# dnd5e Activities Schema Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework `statblockToFoundryActor` (and its verifier) so Tier 3 NPC synthesis produces documents that dnd5e **5.3.3** actually accepts — the current output targets a pre-Activities schema and is rejected at dry-run with `"The value provided to a LocalDocumentField must be a BaseItem instance."`

**Architecture:** A new `activities.ts` module in `packages/statblock-sync` builds the dnd5e activity objects (attack / save / utility) and structured damage parts; `to-foundry.ts` is rewritten to emit modern item and actor shapes; `verify-npc.ts` is updated to read the new paths on read-back. Ground truth is the committed fixture set in `test/fixtures/dnd5e-53-schema/` — real documents extracted from an installed dnd5e 5.3.3 (see its README; a cloud session has no Foundry install, so **these fixtures are the only source of truth — never "correct" them to match code**).

**Tech Stack:** TypeScript (strict, ESM, `.js` import specifiers), vitest, zod (untouched here). No new dependencies.

---

## Context you must read first

1. `test/fixtures/dnd5e-53-schema/README.md` — the legacy→modern schema mapping table and what each fixture proves. This is the spec for every shape below.
2. `docs/statblock-import-execution-plan.md`, section "M6a run log (2026-07-06...)" — how these bugs were found against a live world.
3. `CLAUDE.md` — especially: **`npm test` does NOT type-check** (vitest/esbuild). Run `npm run typecheck` before considering any task done. The `verify-bridge` skill encodes the full gate.

**Constraints:**
- You cannot reach a live Foundry world or the dnd5e install. The final acceptance (M6a: `npm run install:foundry && npm run selftest:live`) is run by the human on their local machine after this lands. Your gate is: build + typecheck + test + `npm run selftest` (mock mode) all green.
- Already fixed, do not redo: `scripts/selftest.mjs --live` mode; `ensureDirectory` in `packages/foundry-module/src/foundry-runtime.ts` (Task 7 only *extracts and tests* it).
- Existing behavior to preserve: which actions become rollable vs. descriptive items is still decided by `parseAttackAction`/`parseSaveAction` on the description text (see the comment on `actionToItem`), not by section headers.

## Critical schema subtleties (easy to get wrong)

- **`flat: true` attacks:** we emit `attack: { flat: true, ability: "none", bonus: "5" }` (the `rotting-touch-weapon.json` pattern) so homebrew to-hit numbers are reproduced exactly. Because `ability` is `"none"`, dnd5e adds **no** ability mod to the weapon's base damage either — so the base damage must carry its explicit bonus (`"1d10 + 3"` → `bonus: "3"`). No double-adding occurs. Official compendium actors instead use `flat: false` with auto-calc; we deliberately don't, because homebrew numbers needn't match mod+prof.
- **Save actions are `feat` items, not weapons** (see Cold Breath in `white-dragon-wyrmling-full.json`). A flat DC is `dc: { calculation: "", formula: "12" }` — empty calculation means "use the formula as-is".
- **`"feature"` is not a dnd5e item type.** Traits, multiattack, reactions, and save actions are all `type: "feat"` with `system.type: { value: "monster", subtype: "" }`.
- **Skill/save proficiency values are multipliers** (`skills.ste.value: 1`), never total bonuses. Totals are derived by dnd5e from ability mod + prof. When the statblock's stated bonus differs from the derived value, the delta goes in `bonuses.check` (skills) / `bonuses.save` (abilities).
- **Recharge** lives on item-level `uses` (`recovery: [{ period: "recharge", formula: "5", type: "recoverAll" }]`, `max: "1"`), and the activity consumes it via `consumption.targets: [{ type: "itemUses", value: "1", target: "", scaling: {} }]`.
- **Size** is `system.traits.size`, not `system.details.size`. **`details.race` must not be emitted at all** — it exists on NPCs as a `LocalDocumentField` (an Item reference, officially `null`; see the ghast fixture), and the legacy `race: { value: "" }` is the confirmed source of the `"must be a BaseItem instance"` rejection. **`details.xp` must not be emitted either** (not an NPC field; XP derives from CR).
- **Movement**: emit numbers, and only the speeds the statblock actually has (officials omit absent speeds entirely — no `climb: 0` noise). **Senses**: numbers under `attributes.senses.ranges`; "passive Perception X" is derived by dnd5e — never emit it, and don't put it in `senses.special`.
- **Officials strip schema-default keys**, so no single fixture document shows the full shape (Ghast's Claw attack activity has no `attack.bonus` key; Rotting Touch's does). When checking structure, union multiple officials (Task 5 does this).

## File structure

| File | Action | Responsibility |
|---|---|---|
| `packages/statblock-sync/src/activities.ts` | Create | Activity + structured-damage builders (pure functions, deterministic via injectable ids) |
| `packages/statblock-sync/src/to-foundry.ts` | Rewrite internals | Statblock → modern actor/items (public signature unchanged) |
| `packages/statblock-sync/src/utils.ts` | Extend | `SKILL_DEFAULT_ABILITY` map |
| `packages/statblock-sync/src/verify-npc.ts` | Rewrite checks | Read-back verification against modern paths |
| `packages/statblock-sync/src/compat.ts` | Create | Record tested dnd5e/core versions |
| `packages/statblock-sync/src/index.ts` | Extend | Export new modules |
| `packages/foundry-module/src/ensure-directory.ts` | Create (extract) | Testable `ensureDirectory` helper |
| `packages/foundry-module/src/foundry-runtime.ts` | Modify | Import the extracted helper |
| `test/integration/statblock-activities.test.ts` | Create | Unit tests for builders |
| `test/integration/statblock-schema-parity.test.ts` | Create | Structural parity vs. committed fixtures |
| `test/integration/statblock-to-foundry.test.ts` | Update | Legacy-path assertions → modern paths |
| `test/integration/statblock-verify.test.ts` | Update | Verifier drives modern shapes |
| `test/integration/statblock-e2e.test.ts`, `statblock-import.test.ts` | Update if red | End-to-end through mock |
| `packages/foundry-module/src/ensure-directory.test.ts` | Create | Non-recursive-createDirectory regression test |

Existing tests currently pass against the legacy shapes, so **expect them to go red during Tasks 2–3 and fix them within the same task** using the README mapping table. Don't delete a failing assertion — translate it.

---

### Task 1: Activity builders (`activities.ts`)

**Files:**
- Create: `packages/statblock-sync/src/activities.ts`
- Modify: `packages/statblock-sync/src/index.ts` (add `export * from "./activities.js";`)
- Test: `test/integration/statblock-activities.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
// test/integration/statblock-activities.test.ts
import { describe, it, expect } from "vitest";
import {
  foundryId,
  toDamagePart,
  attackActivity,
  saveActivity,
  utilityActivity,
  parseTemplate,
} from "@foundry-mcp-bridge/statblock-sync";

// Activities are keyed by id; unwrap to the single activity. `any` because
// the builders intentionally return untyped dnd5e shapes and this test file
// is type-checked by tsconfig.test.json.
const only = (acts: Record<string, unknown>): any => Object.values(acts)[0];

describe("foundryId", () => {
  it("generates 16-char alphanumeric ids", () => {
    for (let i = 0; i < 20; i++) {
      expect(foundryId()).toMatch(/^[A-Za-z0-9]{16}$/);
    }
  });
});

describe("toDamagePart", () => {
  it("converts a dice formula with bonus into the structured shape", () => {
    expect(toDamagePart({ formula: "1d10 + 3", type: "slashing" })).toEqual({
      number: 1,
      denomination: 10,
      bonus: "3",
      types: ["slashing"],
      custom: { enabled: false, formula: "" },
      scaling: { number: 1 },
    });
  });

  it("omits the bonus string when there is none", () => {
    expect(toDamagePart({ formula: "4d6", type: "poison" }).bonus).toBe("");
  });
});

describe("attackActivity", () => {
  it("builds a flat-bonus attack activity keyed by its id", () => {
    const acts = attackActivity({ id: "test0000000000id", bonus: 5, attackType: "melee" });
    const act = only(acts);
    expect(act._id).toBe("test0000000000id");
    expect(acts["test0000000000id"]).toBe(act);
    expect(act.type).toBe("attack");
    expect(act.attack).toEqual({
      critical: { threshold: null },
      flat: true,
      ability: "none",
      bonus: "5",
      type: { value: "melee", classification: "" },
    });
    expect(act.damage.includeBase).toBe(true);
    expect(act.activation.type).toBe("action");
  });

  it("carries extra damage parts (the 'plus Xd Y necrotic' case)", () => {
    const acts = attackActivity({
      id: "test0000000000id",
      bonus: 5,
      attackType: "melee",
      extraParts: [toDamagePart({ formula: "1d6", type: "necrotic" })],
    });
    expect(only(acts).damage.parts).toEqual([
      {
        number: 1,
        denomination: 6,
        bonus: "",
        types: ["necrotic"],
        custom: { enabled: false, formula: "" },
        scaling: { number: 1 },
      },
    ]);
  });
});

describe("saveActivity", () => {
  it("builds a flat-DC save with half-on-success damage", () => {
    const acts = saveActivity({
      id: "test0000000000id",
      ability: "con",
      dc: 12,
      parts: [toDamagePart({ formula: "4d6", type: "poison" })],
      onSave: "half",
      template: { type: "cone", size: "15" },
      consumesItemUse: true,
    });
    const act = only(acts);
    expect(act.type).toBe("save");
    expect(act.save).toEqual({
      ability: ["con"],
      dc: { calculation: "", formula: "12" },
    });
    expect(act.damage.onSave).toBe("half");
    expect(act.target.template).toMatchObject({ type: "cone", size: "15", units: "ft" });
    expect(act.consumption.targets).toEqual([
      { type: "itemUses", value: "1", target: "", scaling: {} },
    ]);
  });

  it("defaults to no template and no item-use consumption", () => {
    const acts = saveActivity({
      id: "test0000000000id",
      ability: "wis",
      dc: 10,
      parts: [],
      onSave: "none",
    });
    const act = only(acts);
    expect(act.target.template.type).toBe("");
    expect(act.consumption.targets).toEqual([]);
  });
});

describe("utilityActivity", () => {
  it("builds an action-activation utility activity", () => {
    const acts = utilityActivity({ id: "test0000000000id", activation: "action" });
    expect(only(acts).type).toBe("utility");
    expect(only(acts).activation.type).toBe("action");
  });

  it("supports reaction activation", () => {
    const acts = utilityActivity({ id: "test0000000000id", activation: "reaction" });
    expect(only(acts).activation.type).toBe("reaction");
  });
});

describe("parseTemplate", () => {
  it("finds an area template in a description", () => {
    expect(
      parseTemplate("Constitution Saving Throw: DC 12, each creature in a 15-foot cone."),
    ).toEqual({ type: "cone", size: "15" });
  });

  it("returns undefined when there is no template", () => {
    expect(parseTemplate("Melee Attack Roll: +5, reach 5 ft.")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/statblock-activities.test.ts`
Expected: FAIL — the imports don't exist yet.

- [ ] **Step 3: Implement `activities.ts`**

```ts
// packages/statblock-sync/src/activities.ts
/**
 * Builders for dnd5e Activities (dnd5e 3.0+ / verified against 5.3.3).
 *
 * Shapes are copied from real documents in test/fixtures/dnd5e-53-schema/
 * (see its README): attack follows rotting-touch-weapon.json (flat bonus),
 * save follows Cold Breath in white-dragon-wyrmling-full.json, utility
 * follows Multiattack in the same file. Do not invent fields — if a shape
 * question comes up, answer it from the fixtures.
 */

import type { DamagePart as GrammarDamagePart } from "./grammar.js";
import { parseDamageFormula } from "./math.js";

const ID_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Random 16-char Foundry document id. */
export function foundryId(): string {
  let id = "";
  for (let i = 0; i < 16; i++) {
    id += ID_CHARS[Math.floor(Math.random() * ID_CHARS.length)];
  }
  return id;
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

// The boilerplate every activity carries, kept to the *minimal* key set that
// appears in ALL official examples (the compendium strips schema defaults, so
// e.g. Ghast's Claw attack activity has no activation.condition while Rotting
// Touch's does — emitting only the common denominator keeps us a key-subset
// of every official document). saveActivity adds the save-specific extras.
function activityCommon(id: string, activation: "action" | "reaction" | "") {
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
  activation?: "action" | "reaction";
}

export function attackActivity(opts: AttackActivityOptions): Activities {
  const id = opts.id ?? foundryId();
  return {
    [id]: {
      ...activityCommon(id, opts.activation ?? "action"),
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
  activation?: "action" | "reaction" | "";
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
        template: {
          contiguous: false,
          units: "ft",
          type: opts.template?.type ?? "",
          size: opts.template?.size ?? "",
          count: "",
        },
        affects: { choice: false, type: opts.template ? "creature" : "", count: "", special: "" },
        override: false,
        prompt: true,
      },
      uses: { spent: 0, recovery: [], max: "" },
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
  activation: "action" | "reaction";
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
```

- [ ] **Step 4: Export from the package index**

In `packages/statblock-sync/src/index.ts`, add alongside the existing re-exports:

```ts
export * from "./activities.js";
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm run build && npx vitest run test/integration/statblock-activities.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add packages/statblock-sync/src/activities.ts packages/statblock-sync/src/index.ts test/integration/statblock-activities.test.ts
git commit -m "feat(statblock-sync): dnd5e activity builders (fixture-verified 5.3.3 shapes)"
```

---

### Task 2: Rewrite item emission in `to-foundry.ts`

**Files:**
- Modify: `packages/statblock-sync/src/to-foundry.ts` (the `actionToItem` function, the trait-items loop in `statblockToFoundryActor`, and `DEFAULT_ITEM_ICONS`)
- Test: `test/integration/statblock-to-foundry.test.ts` (item-shape assertions)

- [ ] **Step 1: Write the failing tests** (add to `statblock-to-foundry.test.ts`; follow the file's existing fixture-loading pattern — it parses `test/fixtures/statblock-import/gravemire-stalker.md`)

```ts
describe("modern dnd5e item shapes (5.3.3 Activities)", () => {
  const statblock = parseStatblock(
    fs.readFileSync("test/fixtures/statblock-import/gravemire-stalker.md", "utf-8"),
  );
  const actor = statblockToFoundryActor(statblock);
  const byName = (n: string) => actor.items.find((i) => i.name === n)!;

  it("never emits the invalid 'feature' item type", () => {
    for (const item of actor.items) {
      expect(["weapon", "feat"]).toContain(item.type);
    }
  });

  it("emits Claw as a natural weapon with structured base damage and a flat attack activity", () => {
    const claw = byName("Claw");
    expect(claw.type).toBe("weapon");
    const sys = claw.system as Record<string, any>;
    expect(sys.type).toEqual({ value: "natural", baseItem: "" });
    expect(sys.damage.base).toMatchObject({
      number: 1,
      denomination: 10,
      bonus: "3",
      types: ["slashing"],
    });
    const acts = Object.values(sys.activities as Record<string, any>);
    expect(acts).toHaveLength(1);
    expect(acts[0].type).toBe("attack");
    expect(acts[0].attack).toMatchObject({ flat: true, ability: "none", bonus: "5" });
    expect(acts[0].damage.includeBase).toBe(true);
    expect(acts[0].damage.parts).toHaveLength(1);
    expect(acts[0].damage.parts[0]).toMatchObject({
      number: 1,
      denomination: 6,
      types: ["necrotic"],
    });
    expect(sys.range).toMatchObject({ reach: 5, units: "ft" });
    // legacy fields must be gone
    expect(sys.attack).toBeUndefined();
    expect(sys.save).toBeUndefined();
    expect(sys.recharge).toBeUndefined();
  });

  it("emits Grave Breath as a feat with a save activity and recharge uses", () => {
    const breath = byName("Grave Breath");
    expect(breath.type).toBe("feat");
    const sys = breath.system as Record<string, any>;
    expect(sys.type).toEqual({ value: "monster", subtype: "" });
    expect(sys.uses).toEqual({
      spent: 0,
      max: "1",
      recovery: [{ period: "recharge", formula: "5", type: "recoverAll" }],
    });
    const act = Object.values(sys.activities as Record<string, any>)[0];
    expect(act.type).toBe("save");
    expect(act.save).toEqual({ ability: ["con"], dc: { calculation: "", formula: "12" } });
    expect(act.damage.onSave).toBe("half");
    expect(act.damage.parts[0]).toMatchObject({ number: 4, denomination: 6, types: ["poison"] });
    expect(act.target.template).toMatchObject({ type: "cone", size: "15" });
    expect(act.consumption.targets).toEqual([
      { type: "itemUses", value: "1", target: "", scaling: {} },
    ]);
  });

  it("emits Multiattack as a feat with a utility activity", () => {
    const multi = byName("Multiattack");
    expect(multi.type).toBe("feat");
    const sys = multi.system as Record<string, any>;
    const act = Object.values(sys.activities as Record<string, any>)[0];
    expect(act.type).toBe("utility");
    expect(act.activation.type).toBe("action");
  });

  it("emits the reaction with reaction activation", () => {
    const grasp = byName("Grasp of the Mire");
    expect(grasp.type).toBe("feat");
    const act = Object.values((grasp.system as Record<string, any>).activities)[0] as any;
    expect(act.activation.type).toBe("reaction");
  });

  it("emits traits as feats flagged with the trait property and no activities", () => {
    const stench = byName("Stench of the Grave");
    expect(stench.type).toBe("feat");
    const sys = stench.system as Record<string, any>;
    expect(sys.type).toEqual({ value: "monster", subtype: "" });
    expect(sys.properties).toEqual(["trait"]);
    expect(sys.activities).toEqual({});
  });
});
```

- [ ] **Step 2: Run to verify the new tests fail** (and note which *existing* tests in this file also fail — you will translate them in Step 4)

Run: `npx vitest run test/integration/statblock-to-foundry.test.ts`
Expected: the new describe-block FAILS on item types/shapes.

- [ ] **Step 3: Rewrite the item-emission code**

Replace `DEFAULT_ITEM_ICONS` and `actionToItem` in `packages/statblock-sync/src/to-foundry.ts`, and update the trait-items loop. New imports at the top of the file:

```ts
import {
  attackActivity,
  saveActivity,
  utilityActivity,
  toDamagePart,
  parseTemplate,
} from "./activities.js";
```

```ts
const DEFAULT_ITEM_ICONS: Record<string, string> = {
  feat: "icons/svg/book.svg",
  weapon: "icons/svg/sword.svg",
};

/** Item-level `uses` for a recharge action, else the empty default. */
function itemUses(recharge?: { value: number; charged: boolean }): Record<string, unknown> {
  if (!recharge) return { spent: 0, recovery: [], max: "" };
  return {
    spent: 0,
    max: "1",
    recovery: [{ period: "recharge", formula: String(recharge.value), type: "recoverAll" }],
  };
}

/** Shared scaffolding for `feat` items (traits, multiattack, save actions, reactions). */
function featSystem(description: string): Record<string, unknown> {
  return {
    description: { value: description, chat: "" },
    type: { value: "monster", subtype: "" },
    properties: [] as string[],
    requirements: "",
    uses: { spent: 0, recovery: [], max: "" },
    activities: {},
  };
}

function actionToItem(action: StatblockData["actions"][0]): Dnd5eItem {
  const attackParsed = parseAttackAction(action.description);
  const saveParsed = parseSaveAction(action.description);
  const activation = action.type === "reaction" ? ("reaction" as const) : ("action" as const);

  if (attackParsed) {
    const [base, ...extra] = attackParsed.damage;
    return {
      name: action.name,
      type: "weapon",
      img: DEFAULT_ITEM_ICONS.weapon,
      system: {
        description: { value: action.description, chat: "" },
        type: { value: "natural", baseItem: "" },
        damage: {
          // No parsed damage (rare): an inert base with no types.
          base: base
            ? toDamagePart(base)
            : { ...toDamagePart({ formula: "0d4", type: "" }), types: [] },
          versatile: {
            number: null,
            denomination: null,
            types: [],
            custom: { enabled: false },
            scaling: { number: 1 },
          },
        },
        range: {
          value: attackParsed.range?.normal ?? null,
          long: attackParsed.range?.long ?? null,
          reach: attackParsed.reach ?? null,
          units: "ft",
        },
        properties: [],
        proficient: null,
        uses: itemUses(action.recharge),
        activities: attackActivity({
          bonus: attackParsed.bonus,
          attackType: attackParsed.type === "ranged" ? "ranged" : "melee",
          extraParts: extra.map(toDamagePart),
          activation,
        }),
      },
    };
  }

  if (saveParsed) {
    const system = featSystem(action.description);
    system.uses = itemUses(action.recharge);
    system.activities = saveActivity({
      ability: saveParsed.ability.toLowerCase().substring(0, 3),
      dc: saveParsed.dc,
      parts: saveParsed.damage.map(toDamagePart),
      onSave: /success:\s*half/i.test(action.description) ? "half" : "none",
      template: parseTemplate(action.description),
      consumesItemUse: !!action.recharge,
      activation,
    });
    return { name: action.name, type: "feat", img: DEFAULT_ITEM_ICONS.feat, system };
  }

  // Purely descriptive (Multiattack, reactions without rolls, …): a feat with
  // a utility activity so it still shows under the right action economy.
  const system = featSystem(action.description);
  system.activities = utilityActivity({ activation });
  return { name: action.name, type: "feat", img: DEFAULT_ITEM_ICONS.feat, system };
}
```

And the trait loop inside `statblockToFoundryActor` becomes:

```ts
  // Add trait features (passive: the "trait" property, no activity)
  for (const ability of statblock.abilities) {
    const system = featSystem(ability.description);
    system.properties = ["trait"];
    items.push({
      name: ability.name,
      type: "feat",
      img: DEFAULT_ITEM_ICONS.feat,
      system,
    });
  }
```

- [ ] **Step 4: Translate now-failing legacy assertions in `statblock-to-foundry.test.ts`**

Use the mapping table in `test/fixtures/dnd5e-53-schema/README.md`. Typical translations:
- `item.type === "feature"` → `"feat"`
- `system.attack.bonus === "+5"` → attack activity `attack.bonus === "5"` (find via `Object.values(system.activities).find(a => a.type === "attack")`)
- `system.damage.parts[0] === ["1d10 + 3", "slashing"]` → `system.damage.base` matches `{number: 1, denomination: 10, bonus: "3", types: ["slashing"]}`
- `system.save.dc.value === 12` → save activity `save.dc.formula === "12"`
- `system.recharge` → `system.uses.recovery[0]` as in Step 1's Grave Breath test

- [ ] **Step 5: Run the file, then the full suite**

Run: `npx vitest run test/integration/statblock-to-foundry.test.ts` → PASS
Run: `npm test` → expect remaining failures only in verify/e2e tests (fixed in Tasks 3–4); note them, do not fix here.

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add packages/statblock-sync/src/to-foundry.ts test/integration/statblock-to-foundry.test.ts
git commit -m "feat(statblock-sync): emit dnd5e 5.3.3 Activities item shapes"
```

---

### Task 3: Rewrite actor `system` emission in `to-foundry.ts`

**Files:**
- Modify: `packages/statblock-sync/src/to-foundry.ts` (the `system` object in `statblockToFoundryActor`, `buildSkills`)
- Modify: `packages/statblock-sync/src/utils.ts` (add `SKILL_DEFAULT_ABILITY`)
- Test: `test/integration/statblock-to-foundry.test.ts`

- [ ] **Step 1: Write the failing tests** (same file, same `actor` setup as Task 2's tests)

```ts
describe("modern dnd5e actor system shapes (5.3.3)", () => {
  const statblock = parseStatblock(
    fs.readFileSync("test/fixtures/statblock-import/gravemire-stalker.md", "utf-8"),
  );
  const actor = statblockToFoundryActor(statblock);
  const sys = actor.system as Record<string, any>;

  it("puts senses under attributes.senses.ranges and never emits passive Perception", () => {
    expect(sys.attributes.senses).toEqual({
      units: null,
      special: "",
      ranges: { darkvision: 60, blindsight: null, tremorsense: null, truesight: null },
    });
  });

  it("uses natural-armor AC calc when the statblock says so", () => {
    // gravemire-stalker.md: "ac: 14 (natural armor)"
    expect(sys.attributes.ac).toEqual({ flat: 14, calc: "natural" });
  });

  it("emits damage/condition traits under traits.dr/di/dv/ci", () => {
    expect(sys.traits.dr).toEqual({ value: ["necrotic"], bypasses: [], custom: "" });
    expect(sys.traits.ci).toEqual({ value: ["charmed"], custom: "" });
    expect(sys.traits.di).toEqual({ value: [], bypasses: [], custom: "" });
    expect(sys.traits.dv).toEqual({ value: [], bypasses: [], custom: "" });
    expect(sys.traits_).toBeUndefined();
  });

  it("puts free-text languages in custom, size under traits", () => {
    // "understands Common but can't speak" is not a language key
    expect(sys.traits.languages).toEqual({
      value: [],
      custom: "understands Common but can't speak",
      communication: {},
    });
    expect(sys.traits.size).toBe("med");
    expect(sys.details.size).toBeUndefined();
  });

  it("emits skill proficiencies as multipliers, not totals", () => {
    // Stealth +4 = dex +2 + prof +2 → multiplier 1, no delta
    expect(sys.skills.ste).toEqual({ value: 1 });
    // Perception +3 = wis +1 + prof +2 → multiplier 1, no delta
    expect(sys.skills.prc).toEqual({ value: 1 });
  });

  it("emits save proficiencies on abilities.<abl>.proficient", () => {
    // WIS save +3 = wis +1 + prof +2 → proficient, no delta
    expect(sys.abilities.wis).toEqual({ value: 12, proficient: 1 });
    expect(sys.abilities.str).toEqual({ value: 16 });
  });

  it("emits only the speeds the statblock defines", () => {
    // gravemire-stalker.md: "speed: 30 ft., swim 20 ft." — no climb: 0 noise
    expect(sys.attributes.movement).toEqual({ walk: 30, swim: 20, units: "ft", hover: false });
  });

  it("does not emit details.race (LocalDocumentField) or details.xp (derived)", () => {
    expect(sys.details.race).toBeUndefined();
    expect(sys.details.xp).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `npx vitest run test/integration/statblock-to-foundry.test.ts`
Expected: the new block FAILS (legacy paths).

- [ ] **Step 3: Add the skill→default-ability map to `utils.ts`** (next to `SKILL_TO_ABBREVIATION_MAP`)

```ts
/** dnd5e default ability per skill abbreviation (for deriving expected bonuses). */
export const SKILL_DEFAULT_ABILITY: Record<string, string> = {
  acr: "dex", ani: "wis", arc: "int", ath: "str", dec: "cha", his: "int",
  ins: "wis", itm: "cha", inv: "int", med: "wis", nat: "int", prc: "wis",
  prf: "cha", per: "cha", rel: "int", slt: "dex", ste: "dex", sur: "wis",
};
```

- [ ] **Step 4: Rewrite the actor `system` construction**

In `statblockToFoundryActor`, replace the `system` literal and `buildSkills` with:

```ts
import { SKILL_TO_ABBREVIATION_MAP, SKILL_DEFAULT_ABILITY } from "./utils.js";
import { getAbilityModifier, getProficiencyBonus, getAbilityMod } from "./math.js";
```

```ts
const KNOWN_DAMAGE_TYPES = new Set([
  "acid", "bludgeoning", "cold", "fire", "force", "lightning", "necrotic",
  "piercing", "poison", "psychic", "radiant", "slashing", "thunder",
]);
const KNOWN_CONDITIONS = new Set([
  "blinded", "charmed", "deafened", "exhaustion", "frightened", "grappled",
  "incapacitated", "invisible", "paralyzed", "petrified", "poisoned", "prone",
  "restrained", "stunned", "unconscious",
]);
const KNOWN_LANGUAGES = new Set([
  "common", "dwarvish", "elvish", "giant", "gnomish", "goblin", "halfling",
  "orc", "abyssal", "celestial", "draconic", "deep speech", "infernal",
  "primordial", "sylvan", "undercommon", "common sign language", "thieves' cant", "druidic",
]);

/** Split a trait list into dnd5e keys vs. free text ("magical bludgeoning…"). */
function splitKnown(values: string[], known: Set<string>): { value: string[]; custom: string } {
  const value: string[] = [];
  const custom: string[] = [];
  for (const v of values) {
    const k = v.trim().toLowerCase();
    if (known.has(k)) value.push(k);
    else if (v.trim()) custom.push(v.trim());
  }
  return { value, custom: custom.join("; ") };
}

/** "darkvision 60 ft." lists → attributes.senses; passive Perception is derived, drop it. */
function buildSenses(senses: string[]): Record<string, unknown> {
  const ranges: Record<string, number | null> = {
    darkvision: null, blindsight: null, tremorsense: null, truesight: null,
  };
  const special: string[] = [];
  for (const s of senses) {
    const m = s.match(/(darkvision|blindsight|tremorsense|truesight)\s+(\d+)\s*ft/i);
    if (m) ranges[m[1]!.toLowerCase()] = parseInt(m[2]!, 10);
    else if (!/passive\s+perception/i.test(s)) special.push(s.trim());
  }
  return { units: null, special: special.join("; "), ranges };
}
```

```ts
  const prof = getProficiencyBonus(statblock.challenge.cr);

  // Skill proficiencies as multipliers; statblock-vs-derived deltas go in bonuses.check.
  const skills: Record<string, Record<string, unknown>> = {};
  for (const p of statblock.skills.proficiencies) {
    const abbrev = SKILL_TO_ABBREVIATION_MAP[p.skill.toLowerCase().replace(/ of hand/, "")];
    if (!abbrev) continue;
    const mod = getAbilityMod(statblock.abilities_, SKILL_DEFAULT_ABILITY[abbrev] ?? "wis");
    const delta = p.bonus - (mod + prof);
    skills[abbrev] = delta === 0 ? { value: 1 } : { value: 1, bonuses: { check: String(delta) } };
  }

  // Ability scores; save proficiencies live on abilities.<abl>.proficient.
  const abilities: Record<string, Record<string, unknown>> = {};
  for (const key of ["str", "dex", "con", "int", "wis", "cha"] as const) {
    abilities[key] = { value: abilities_[key] };
  }
  for (const save of statblock.skills.savingThrows) {
    const key = save.ability.toLowerCase().substring(0, 3);
    if (!abilities[key]) continue;
    const delta = save.bonus - (getAbilityModifier(abilities_[key as keyof typeof abilities_]) + prof);
    abilities[key].proficient = 1;
    if (delta !== 0) abilities[key].bonuses = { save: String(delta) };
  }

  const dr = splitKnown(statblock.traits.damageResistances, KNOWN_DAMAGE_TYPES);
  const di = splitKnown(statblock.traits.damageImmunities, KNOWN_DAMAGE_TYPES);
  const dv = splitKnown(statblock.traits.damageVulnerabilities, KNOWN_DAMAGE_TYPES);
  const ci = splitKnown(statblock.traits.conditionImmunities, KNOWN_CONDITIONS);
  const langs = splitKnown(statblock.traits.languages, KNOWN_LANGUAGES);

  const system: Record<string, unknown> = {
    attributes: {
      ac: {
        flat: statblock.attributes.armorClass,
        calc: /natural/i.test(statblock.data.ac_class ?? "") ? "natural" : "flat",
      },
      hp: {
        value: statblock.attributes.hitPoints.value,
        max: statblock.attributes.hitPoints.value,
        formula: statblock.attributes.hitPoints.formula,
      },
      movement: {
        // Only the speeds the statblock has — officials omit absent speeds
        // entirely (ghast: walk only; wyrmling: walk/fly/swim/burrow).
        ...Object.fromEntries(
          Object.entries(statblock.attributes.speed).filter(
            ([, v]) => typeof v === "number" && v > 0,
          ),
        ),
        units: "ft",
        hover: false,
      },
      senses: buildSenses(statblock.traits.senses),
    },
    details: {
      biography: { value: "" },
      alignment: statblock.creatureType.alignment,
      type: {
        value: statblock.creatureType.type,
        subtype: statblock.creatureType.subtype ?? "",
      },
      cr: statblock.challenge.cr,
      // No xp (dnd5e derives it from CR) and — critically — no `race`: on
      // NPCs it's a LocalDocumentField (Item reference, officially null); the
      // legacy `race: { value: "" }` is what dry-run rejected with
      // "The value provided to a LocalDocumentField must be a BaseItem instance."
    },
    traits: {
      size: statblock.creatureType.size,
      languages: { value: langs.value, custom: langs.custom, communication: {} },
      dr: { value: dr.value, bypasses: [], custom: dr.custom },
      di: { value: di.value, bypasses: [], custom: di.custom },
      dv: { value: dv.value, bypasses: [], custom: dv.custom },
      ci: { value: ci.value, custom: ci.custom },
    },
    abilities,
    skills,
  };
```

Delete the old `buildSkills` function and the `traits_` / `details.race` / `details.size` / flat `traits.senses` emissions entirely.

Check `statblock.data.ac_class` exists on the zod `Statblock` type in `schema.ts` (the parse output for gravemire-stalker.md shows `ac_class: "natural armor"`); if the field is named differently, follow the schema — do not add a new field.

- [ ] **Step 5: Run the file, translate any remaining legacy assertions, then run the suite**

Run: `npx vitest run test/integration/statblock-to-foundry.test.ts` → PASS
Run: `npm test` → only verify/e2e failures may remain (Task 4).

- [ ] **Step 6: Typecheck and commit**

```bash
npm run typecheck
git add packages/statblock-sync/src/to-foundry.ts packages/statblock-sync/src/utils.ts test/integration/statblock-to-foundry.test.ts
git commit -m "feat(statblock-sync): emit dnd5e 5.3.3 actor system shapes"
```

---

### Task 4: Update `verify-npc.ts` to read modern paths

**Files:**
- Modify: `packages/statblock-sync/src/verify-npc.ts`
- Test: `test/integration/statblock-verify.test.ts`

The verifier runs against **read-back** from the world, so it must read the same modern paths the converter now writes. It also gains checks M6b needs programmatically: recharge, skill/save proficiency, senses.

- [ ] **Step 1: Write/adjust the failing tests**

In `statblock-verify.test.ts`, the existing tests build read-back doubles in the legacy shape — rebuild them by round-tripping the converter (the honest setup):

```ts
import { parseStatblock, statblockToFoundryActor, verifyImportedNpc } from "@foundry-mcp-bridge/statblock-sync";

const statblock = parseStatblock(
  fs.readFileSync("test/fixtures/statblock-import/gravemire-stalker.md", "utf-8"),
);

function readBackFromConverter(): any {
  // What the world hands back is (a superset of) what we wrote.
  return { _id: "test000000000000", ...statblockToFoundryActor(statblock, "worlds/npcs/g/g.png") };
}

describe("verifyImportedNpc against modern shapes", () => {
  it("passes on a faithful read-back", () => {
    const report = verifyImportedNpc(readBackFromConverter(), statblock);
    expect(report.checks.filter((c) => !c.pass)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("fails the to-hit check when the attack activity bonus is wrong", () => {
    const rb = readBackFromConverter();
    const claw = rb.items.find((i: any) => i.name === "Claw");
    const act: any = Object.values(claw.system.activities)[0];
    act.attack.bonus = "3";
    const report = verifyImportedNpc(rb, statblock);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name === `"Claw" to-hit`)?.pass).toBe(false);
  });

  it("fails the DC check when the save activity formula is wrong", () => {
    const rb = readBackFromConverter();
    const breath = rb.items.find((i: any) => i.name === "Grave Breath");
    const act: any = Object.values(breath.system.activities)[0];
    act.save.dc.formula = "15";
    const report = verifyImportedNpc(rb, statblock);
    expect(report.checks.find((c) => c.name === `"Grave Breath" save DC`)?.pass).toBe(false);
  });

  it("fails the recharge check when uses.recovery is missing", () => {
    const rb = readBackFromConverter();
    const breath = rb.items.find((i: any) => i.name === "Grave Breath");
    breath.system.uses = { spent: 0, recovery: [], max: "" };
    const report = verifyImportedNpc(rb, statblock);
    expect(report.checks.find((c) => c.name === `"Grave Breath" recharge`)?.pass).toBe(false);
  });

  it("checks skill and save proficiency multipliers", () => {
    const rb = readBackFromConverter();
    rb.system.skills.ste = { value: 0 };
    const report = verifyImportedNpc(rb, statblock);
    expect(report.checks.find((c) => c.name === "Skill stealth proficient")?.pass).toBe(false);
  });

  it("checks darkvision range", () => {
    const rb = readBackFromConverter();
    rb.system.attributes.senses.ranges.darkvision = null;
    const report = verifyImportedNpc(rb, statblock);
    expect(report.checks.find((c) => c.name === "Senses: darkvision 60 ft")?.pass).toBe(false);
  });
});
```

Keep any existing tests in the file that still make sense (name/AC/HP/image checks) and update their read-back doubles to the round-trip helper.

- [ ] **Step 2: Run to verify failures**

Run: `npx vitest run test/integration/statblock-verify.test.ts`
Expected: FAIL (verifier still reads `system.attack.bonus` etc.).

- [ ] **Step 3: Update the verifier's mechanical checks**

In `verify-npc.ts`, replace the attack/save block of `verifyImportedNpc` (the `for (const action of statblock.actions)` loop bodies for `attackParsed`/`saveParsed`) with:

```ts
    const itemSystem = item.system as Record<string, any>;
    const activities = Object.values((itemSystem?.activities ?? {}) as Record<string, any>);

    if (attackParsed) {
      const attackAct = activities.find((a) => a.type === "attack");
      const got = attackAct ? parseInt(String(attackAct.attack?.bonus ?? ""), 10) : undefined;
      checks.push({
        name: `"${action.name}" to-hit`,
        pass: got === attackParsed.bonus,
        got,
        want: attackParsed.bonus,
      });
    }

    if (saveParsed) {
      const saveAct = activities.find((a) => a.type === "save");
      const got = saveAct ? parseInt(String(saveAct.save?.dc?.formula ?? ""), 10) : undefined;
      checks.push({
        name: `"${action.name}" save DC`,
        pass: got === saveParsed.dc,
        got,
        want: saveParsed.dc,
      });
    }

    if (action.recharge) {
      const recovery = (itemSystem?.uses?.recovery ?? []) as Array<Record<string, any>>;
      const got = recovery.find((r) => r.period === "recharge")?.formula;
      checks.push({
        name: `"${action.name}" recharge`,
        pass: got === String(action.recharge.value),
        got,
        want: String(action.recharge.value),
      });
    }
```

Then, after the ability-scores block, add proficiency and senses checks:

```ts
  // Skill proficiencies (multiplier semantics, dnd5e 5.x)
  const skillsRB = system.skills as Record<string, any>;
  for (const p of statblock.skills.proficiencies) {
    const abbrev = SKILL_TO_ABBREVIATION_MAP[p.skill.toLowerCase().replace(/ of hand/, "")];
    if (!abbrev) continue;
    const got = skillsRB?.[abbrev]?.value;
    checks.push({
      name: `Skill ${p.skill.toLowerCase()} proficient`,
      pass: typeof got === "number" && got >= 1,
      got,
      want: ">=1",
    });
  }

  // Save proficiencies
  for (const save of statblock.skills.savingThrows) {
    const key = save.ability.toLowerCase().substring(0, 3);
    const got = abilities?.[key]?.proficient;
    checks.push({
      name: `${key.toUpperCase()} save proficient`,
      pass: got === 1,
      got,
      want: 1,
    });
  }

  // Senses ranges
  const rangesRB = (system.attributes?.senses as Record<string, any>)?.ranges ?? {};
  for (const s of statblock.traits.senses) {
    const m = s.match(/(darkvision|blindsight|tremorsense|truesight)\s+(\d+)\s*ft/i);
    if (!m) continue;
    const kind = m[1]!.toLowerCase();
    const want = parseInt(m[2]!, 10);
    checks.push({
      name: `Senses: ${kind} ${want} ft`,
      pass: rangesRB[kind] === want,
      got: rangesRB[kind],
      want,
    });
  }
```

Add the needed import at the top: `import { SKILL_TO_ABBREVIATION_MAP } from "./utils.js";`

- [ ] **Step 4: Run this file, then the whole suite (e2e/import tests should now go green too)**

Run: `npx vitest run test/integration/statblock-verify.test.ts` → PASS
Run: `npm test` → PASS everywhere. If `statblock-e2e.test.ts` / `statblock-import.test.ts` still assert legacy shapes directly, translate those assertions with the same mapping table.

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add packages/statblock-sync/src/verify-npc.ts test/integration/statblock-verify.test.ts test/integration/statblock-e2e.test.ts test/integration/statblock-import.test.ts
git commit -m "feat(statblock-sync): verify read-back against 5.3.3 activity shapes; add recharge/proficiency/senses checks"
```

---

### Task 5: Schema-parity tests against the committed fixtures

**Files:**
- Create: `test/integration/statblock-schema-parity.test.ts`

This is the test that would have caught the original bug: every key we emit must exist in the corresponding *real* dnd5e 5.3.3 document. Value differences are fine (flat vs. auto-calc); **inventing keys dnd5e doesn't have is not**.

- [ ] **Step 1: Write the test (it should pass immediately if Tasks 2–3 are correct — its value is as a tripwire)**

```ts
// test/integration/statblock-schema-parity.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import { parseStatblock, statblockToFoundryActor } from "@foundry-mcp-bridge/statblock-sync";

const load = (f: string) =>
  JSON.parse(fs.readFileSync(`test/fixtures/dnd5e-53-schema/${f}`, "utf-8"));
const ghast = load("ghast-full.json");
const wyrmling = load("white-dragon-wyrmling-full.json");
const rottingTouch = load("rotting-touch-weapon.json");
const abduct = load("abduct-feat.json");

const statblock = parseStatblock(
  fs.readFileSync("test/fixtures/statblock-import/gravemire-stalker.md", "utf-8"),
);
const actor = statblockToFoundryActor(statblock);

/**
 * Compendium documents strip schema-default keys, so no single official shows
 * the full legal shape (Ghast's Claw attack activity has no attack.bonus key;
 * Rotting Touch's does). Union multiple officials into one reference: an
 * emitted key is legal iff SOME official document carries it.
 */
function mergeOfficials(a: unknown, b: unknown): unknown {
  if (a === null || a === undefined) return b;
  if (b === null || b === undefined) return a;
  if (Array.isArray(a) || Array.isArray(b)) {
    const aa = Array.isArray(a) ? a : [];
    const bb = Array.isArray(b) ? b : [];
    return aa.length >= bb.length ? aa : bb;
  }
  if (typeof a !== "object" || typeof b !== "object") return a;
  const out: Record<string, unknown> = { ...(a as Record<string, unknown>) };
  for (const [k, v] of Object.entries(b as Record<string, unknown>)) {
    out[k] = k in out ? mergeOfficials(out[k], v) : v;
  }
  return out;
}

/**
 * Assert every key path in `emitted` also exists in `official` (the merged
 * reference). Values may differ; inventing keys dnd5e doesn't have may not.
 * Arrays: elements are compared against the official array's first element
 * when one exists. Reports the offending path on failure.
 */
function expectKeySubset(emitted: unknown, official: unknown, path = "$"): void {
  if (emitted === null || typeof emitted !== "object") return;
  if (Array.isArray(emitted)) {
    const officialFirst = Array.isArray(official) ? official[0] : undefined;
    if (officialFirst === undefined) return;
    for (const el of emitted) expectKeySubset(el, officialFirst, `${path}[]`);
    return;
  }
  expect(official, `${path} exists in the official documents`).toBeTypeOf("object");
  for (const [k, v] of Object.entries(emitted as Record<string, unknown>)) {
    expect(
      Object.prototype.hasOwnProperty.call(official as object, k),
      `${path}.${k} is a real dnd5e 5.3.3 key`,
    ).toBe(true);
    expectKeySubset(v, (official as Record<string, unknown>)[k], `${path}.${k}`);
  }
}

const itemByName = (doc: { items: any[] }, name: string) =>
  doc.items.find((i: any) => i.name === name);
const activityOfType = (item: any, type: string): any =>
  Object.values(item.system.activities as Record<string, any>).find((a) => a.type === type);

describe("emitted shapes are key-subsets of real dnd5e 5.3.3 documents", () => {
  const ghastClaw = itemByName(ghast, "Claw");
  const stench = itemByName(ghast, "Stench");
  const breathOfficial = itemByName(wyrmling, "Cold Breath");
  const multiOfficial = itemByName(wyrmling, "Multiattack");

  const emittedClaw = actor.items.find((i) => i.name === "Claw")! as any;
  const emittedBreath = actor.items.find((i) => i.name === "Grave Breath")! as any;
  const emittedMulti = actor.items.find((i) => i.name === "Multiattack")! as any;
  const emittedTrait = actor.items.find((i) => i.name === "Stench of the Grave")! as any;

  it("attack weapon system and activity", () => {
    const { activities: _e, ...emittedSys } = emittedClaw.system;
    const { activities: _o1, ...clawSys } = ghastClaw.system;
    const { activities: _o2, ...rtSys } = rottingTouch.system;
    expectKeySubset(emittedSys, mergeOfficials(clawSys, rtSys), "claw.system");
    expectKeySubset(
      activityOfType(emittedClaw, "attack"),
      mergeOfficials(activityOfType(ghastClaw, "attack"), activityOfType(rottingTouch, "attack")),
      "claw.attackActivity",
    );
  });

  it("save feat system and activity (vs Cold Breath + Stench)", () => {
    const { activities: _e, ...emittedSys } = emittedBreath.system;
    const { activities: _o1, ...breathSys } = breathOfficial.system;
    const { activities: _o2, ...stenchSys } = stench.system;
    expectKeySubset(emittedSys, mergeOfficials(breathSys, stenchSys), "breath.system");
    expectKeySubset(
      activityOfType(emittedBreath, "save"),
      mergeOfficials(activityOfType(breathOfficial, "save"), activityOfType(stench, "save")),
      "breath.saveActivity",
    );
  });

  it("utility feat (vs Multiattack)", () => {
    const { activities: _e, ...emittedSys } = emittedMulti.system;
    const { activities: _o, ...multiSys } = multiOfficial.system;
    expectKeySubset(emittedSys, multiSys, "multiattack.system");
    expectKeySubset(
      activityOfType(emittedMulti, "utility"),
      activityOfType(multiOfficial, "utility"),
      "multiattack.utilityActivity",
    );
  });

  it("passive trait feat (vs Stench + Abduct)", () => {
    const { activities: _e, ...emittedSys } = emittedTrait.system;
    const { activities: _o1, ...stenchSys } = stench.system;
    const { activities: _o2, ...abductSys } = abduct.system;
    expectKeySubset(emittedSys, mergeOfficials(stenchSys, abductSys), "trait.system");
  });

  it("actor system (vs Ghast + Wyrmling union)", () => {
    expectKeySubset(actor.system, mergeOfficials(ghast.system, wyrmling.system), "actor.system");
  });

  it("item types are real dnd5e types", () => {
    for (const item of actor.items) expect(["weapon", "feat"]).toContain(item.type);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run test/integration/statblock-schema-parity.test.ts`
Expected: PASS. Any failure names the exact invented key path — fix the *converter* (Tasks 2–3 code), never the fixture.

Note: every comparison pairs the emitted shape with the union of the official documents that legitimately carry those keys (attack vs Ghast Claw + Rotting Touch, save vs Cold Breath + Stench, actor vs Ghast + Wyrmling). On any failure the assertion message names the offending key path — fix the **converter** (or, if the key genuinely exists in dnd5e, add an official document to the fixtures directory *locally verified by the human* — never hand-edit a fixture).

- [ ] **Step 3: Commit**

```bash
git add test/integration/statblock-schema-parity.test.ts
git commit -m "test: schema-parity tripwire against committed dnd5e 5.3.3 fixtures"
```

---

### Task 6: Record tested versions in `compat.ts`

**Files:**
- Create: `packages/statblock-sync/src/compat.ts`
- Modify: `packages/statblock-sync/src/index.ts`

(The execution plan's M6b step says to record the tested dnd5e version here; the schema work was verified against these exact versions.)

- [ ] **Step 1: Create the file**

```ts
// packages/statblock-sync/src/compat.ts
/**
 * The system/core versions the statblock→actor conversion was last verified
 * against (schema fixtures in test/fixtures/dnd5e-53-schema/ were extracted
 * from this exact install; M6 live verification runs against it).
 */
export const TESTED_COMPAT = {
  dnd5e: "5.3.3",
  foundryCore: "14.364",
  fixturesExtracted: "2026-07-06",
} as const;
```

- [ ] **Step 2: Export it**

In `packages/statblock-sync/src/index.ts`: `export * from "./compat.js";`

- [ ] **Step 3: Build, typecheck, commit**

```bash
npm run build && npm run typecheck
git add packages/statblock-sync/src/compat.ts packages/statblock-sync/src/index.ts
git commit -m "chore(statblock-sync): record tested dnd5e 5.3.3 / core 14.364 compat"
```

---

### Task 7: Regression coverage for the `ensureDirectory` fix (Bug 1)

**Files:**
- Create: `packages/foundry-module/src/ensure-directory.ts`
- Create: `packages/foundry-module/src/ensure-directory.test.ts`
- Modify: `packages/foundry-module/src/foundry-runtime.ts`

The live-world fix (walk the path because `FilePicker.createDirectory` is **not** recursive) currently lives untested inside `foundry-runtime.ts`, which CI never runs. Extract it behind a narrow interface and pin its behavior.

- [ ] **Step 1: Write the failing test**

```ts
// packages/foundry-module/src/ensure-directory.test.ts
import { describe, it, expect } from "vitest";
import { ensureDirectory, type DirectoryCreator } from "./ensure-directory.js";

/** Faithful fake: non-recursive (parent must exist) and throws on existing. */
function fakeFilePicker(preexisting: string[] = []) {
  const dirs = new Set<string>(preexisting);
  const creator: DirectoryCreator = {
    async createDirectory(_source, target) {
      if (dirs.has(target)) throw new Error(`EEXIST: ${target} already exists.`);
      const parent = target.split("/").slice(0, -1).join("/");
      if (parent && !dirs.has(parent)) {
        throw new Error(`Target directory ${target} does not exist.`);
      }
      dirs.add(target);
    },
  };
  return { creator, dirs };
}

describe("ensureDirectory", () => {
  it("creates every missing level of a nested path in order", async () => {
    const { creator, dirs } = fakeFilePicker();
    await ensureDirectory(creator, "data", "worlds/npcs/gravemire-stalker");
    expect([...dirs]).toEqual(["worlds", "worlds/npcs", "worlds/npcs/gravemire-stalker"]);
  });

  it("is idempotent when the path already exists", async () => {
    const { creator, dirs } = fakeFilePicker(["worlds", "worlds/npcs", "worlds/npcs/x"]);
    await ensureDirectory(creator, "data", "worlds/npcs/x");
    expect(dirs.size).toBe(3);
  });

  it("completes a partially existing path", async () => {
    const { creator, dirs } = fakeFilePicker(["worlds"]);
    await ensureDirectory(creator, "data", "worlds/npcs/deep/deeper");
    expect(dirs.has("worlds/npcs/deep/deeper")).toBe(true);
  });

  it("ignores trailing and duplicate slashes", async () => {
    const { creator, dirs } = fakeFilePicker();
    await ensureDirectory(creator, "data", "worlds//npcs/");
    expect([...dirs]).toEqual(["worlds", "worlds/npcs"]);
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npx vitest run packages/foundry-module/src/ensure-directory.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Extract the helper**

```ts
// packages/foundry-module/src/ensure-directory.ts
/**
 * Unlike `mkdir -p`, Foundry's FilePicker.createDirectory requires the
 * *parent* to already exist — creating "a/b/c" in one call fails if "a/b"
 * isn't there yet — and throws when the directory already exists. Walk the
 * path and create each level in order; per-level errors are ignored (an
 * "already exists" is expected, and a real failure surfaces again, more
 * informatively, on the following upload/browse).
 *
 * Kept behind the narrow DirectoryCreator seam so this is testable in CI
 * without Foundry globals (foundry-runtime.ts itself never runs in CI).
 */
export interface DirectoryCreator {
  createDirectory(source: string, target: string): Promise<unknown>;
}

export async function ensureDirectory(
  fp: DirectoryCreator,
  source: string,
  target: string,
): Promise<void> {
  let path = "";
  for (const segment of target.split("/").filter(Boolean)) {
    path = path ? `${path}/${segment}` : segment;
    try {
      await fp.createDirectory(source, path);
    } catch {
      // already exists (or will fail again, more informatively, on upload/browse)
    }
  }
}
```

In `foundry-runtime.ts`: delete the local `ensureDirectory` function, add
`import { ensureDirectory } from "./ensure-directory.js";`, and change both call
sites to pass the global: `await ensureDirectory(FilePicker as any, params.source, target);`

- [ ] **Step 4: Run test + full gate for the module**

Run: `npx vitest run packages/foundry-module/src/ensure-directory.test.ts` → PASS
Run: `npm run typecheck && npm run bundle:module` → clean.

- [ ] **Step 5: Commit**

```bash
git add packages/foundry-module/src/ensure-directory.ts packages/foundry-module/src/ensure-directory.test.ts packages/foundry-module/src/foundry-runtime.ts
git commit -m "test(foundry-module): extract ensureDirectory behind a seam and pin non-recursive createDirectory behavior"
```

---

### Task 8: Full verification gate and handoff

- [ ] **Step 1: Run the full gate (the `verify-bridge` skill order)**

```bash
npm run build && npm run typecheck && npm test && npm run selftest
```

Expected: all green, including the mock-mode M6 NPC leg (`M6 NPC import verification: N/N passed`). Note the check count likely **grew** (recharge/proficiency/senses checks added in Task 4) — that's correct.

- [ ] **Step 2: Update the run-log pointer**

In `docs/statblock-import-execution-plan.md`, in the "M6a run log" section, replace the sentence beginning "Real fix is a rework of `statblockToFoundryActor`…" up to "…re-run `npm run selftest:live` from M6a top." with:

```markdown
Fixed by the Activities-schema rewrite (see
`docs/superpowers/plans/2026-07-06-dnd5e-activities-schema-rewrite.md`;
ground-truth fixtures in `test/fixtures/dnd5e-53-schema/`). Re-run M6a from
the top (`npm run install:foundry && npm run selftest:live`) to confirm
against the live world.
```

- [ ] **Step 3: Commit and stop**

```bash
git add docs/statblock-import-execution-plan.md
git commit -m "docs: point M6a run log at the completed Activities rewrite"
```

Then **report back and stop**. Do not attempt live verification — the human runs M6a on their local machine (`npm run install:foundry`, reload the Foundry world so the rebuilt module loads, then `npm run selftest:live` with the relay port free), and only they can do the M6b manual checklist.
