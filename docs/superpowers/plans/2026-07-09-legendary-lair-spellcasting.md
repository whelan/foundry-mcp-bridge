# Legendary/Lair Resources + Spellcasting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `docs/statblock-legendary-lair-spellcasting-plan.md` in full: (Part A) emit dnd5e's
`resources.legact/legres/lair` actor fields so legendary actions, legendary resistance, and lair actions
are actually functional on the Foundry sheet, not just correctly-typed action items; (Part B) add spell
support to statblock-sync via a new `import_embedded_from_compendium` wire-protocol command, matching
parsed spell names against the official `dnd5e.spells24` compendium.

**Architecture:** Part A is confined to `packages/statblock-sync` (schema → parse → to-foundry → verify).
Part B first adds a new command end-to-end through the shared protocol/executor/runtime/mock/reliability
stack (the `add-foundry-command` lockstep), then wires `statblock-sync`'s `grammar.ts`/`to-foundry.ts`/
`import-npc.ts`/`verify-npc.ts` on top of it. Both parts follow the existing mock-first discipline: every
new behavior is proven against `MockFoundry` before any live-Foundry pass.

**Tech Stack:** TypeScript, zod, vitest, the existing `foundry-mcp-bridge` monorepo (`packages/shared`,
`packages/foundry-module`, `packages/mcp-server`, `packages/statblock-sync`, `test/integration`).

**Corrections to the source design doc found during research** (fix silently while implementing, don't
re-litigate):
1. `docs/statblock-legendary-lair-spellcasting-plan.md` claims no legendary/lair fixture exists yet ("gets
   a second legendary-creature fixture into rotation"). **False** — `test/fixtures/statblock-import/duskfang-bog-wyrm.md`
   already has both, is already driven end-to-end in `test/integration/statblock-import.test.ts`. Young Ash
   Wyrm is *additive* (it's the first fixture with a Legendary Resistance trait), not "the first" legendary fixture.
2. `actionToItem` lives at `to-foundry.ts:306-377`, not `:280-300` as the doc guesses.
3. The doc's suggested spellcasting-trait regex (`/^(Cantrips...)/gm`) assumes the trait's `desc` contains
   real newlines. It won't: the acceptance NPC's YAML uses a **double-quoted folded scalar**, and YAML
   folds line breaks in a double-quoted scalar into single spaces (no line is empty or backslash-continued).
   After `yaml`'s parse, the whole trait becomes one long space-separated string — `/gm` line-anchors never
   match past the first line, and a greedy `(.+)$` would swallow everything to the end of the string anyway.
   Task 15 below uses a header-anchored (not line-anchored) parser that works regardless of whether real
   newlines survive.
4. `system.spells.spellN` (confirmed from `test/fixtures/dnd5e-53-schema/white-dragon-wyrmling-full.json`)
   is `{ value, override }` — there is **no stored `max`** (it's a derived getter). Slot counts must be
   written to `override` (the NPC-mode explicit max) and `value` (current remaining), not a `max` key.
5. There is no settable numeric DC field on `system.attributes.spell` — DC/attack bonus are always
   *derived* from `attributes.spellcasting` (ability) + proficiency bonus. Rather than guess at an
   override formula field, Task 19's acceptance NPC is authored so its ability score/CR naturally derive
   the stated DC/attack bonus (see Task 19), and Task 18's verify checks assert the derivation instead of
   a stored field.
6. `.claude/settings.json`'s `permissions.allow` list does **not** include `mcp__foundry__search_compendium`
   or `mcp__foundry__import_from_compendium` today — so `import_embedded_from_compendium` is intentionally
   **not** added either, matching that existing precedent (compendium tools require a prompt).
7. The dnd5e-srd fixture loader (`test/fixtures/dnd5e-srd/loader.ts`) maps `Item` to a single pack slug
   (`monsterfeatures24`) for the whole process — it cannot represent two different Item packs
   (`dnd5e.monsterfeatures24` vs `dnd5e.spells24`) at once. Task 20's spell-fixture tests seed
   `MockFoundry.compendium` (a public `Map`) directly instead of extending the shared loader — smaller,
   local, doesn't touch fixture infra other suites depend on.

---

## Part A — Legendary actions, lair actions, legendary resistance

### Task 1: `schema.ts` — `legendary_action_count` field + ability `legendaryResistanceUses`

**Files:**
- Modify: `packages/statblock-sync/src/schema.ts`

- [ ] **Step 1: Add the optional override field to `StatblockSchema`**

In `packages/statblock-sync/src/schema.ts`, in the `StatblockSchema` object (right after `legendary_actions`/`lair_actions`):

```ts
    legendary_actions: z.array(NamedEntrySchema).optional(),
    lair_actions: z.array(NamedEntrySchema).optional(),
    /** Explicit legendary-action budget override; defaults to legendary_actions.length when absent. */
    legendary_action_count: z.number().int().nonnegative().optional(),
```

- [ ] **Step 2: Add `legendaryResistanceUses` to the `abilities` entry type**

In the `StatblockData` interface, change:

```ts
  /** Parsed abilities/traits (from the `traits` list) */
  abilities: {
    name: string;
    description: string;
    passive?: boolean;
  }[];
```

to:

```ts
  /** Parsed abilities/traits (from the `traits` list) */
  abilities: {
    name: string;
    description: string;
    passive?: boolean;
    /** Parsed "(N/Day)" count from a "Legendary Resistance" trait name, if present. */
    legendaryResistanceUses?: number;
  }[];
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: fails only in `parse.ts`/`to-foundry.ts` call sites that don't yet populate the new optional
field — none should fail yet since both fields are optional. Expected: PASS (no errors).

- [ ] **Step 4: Commit**

```bash
git add packages/statblock-sync/src/schema.ts
git commit -m "feat(statblock-sync): add legendary_action_count and legendaryResistanceUses schema fields"
```

---

### Task 2: `parse.ts` — extract Legendary Resistance `(N/Day)` from trait names

**Files:**
- Modify: `packages/statblock-sync/src/parse.ts`
- Test: `test/integration/statblock-parse.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/integration/statblock-parse.test.ts`, inside the `describe("M1: Statblock Parsing", ...)` block
(near the existing legendary/lair test):

```ts
  it("extracts (N/Day) uses from a Legendary Resistance trait and strips it from the name", () => {
    const markdown = `\`\`\`statblock
name: Test Dragon
cr: 10
ac: 18
hp: 150
stats: [20, 10, 18, 10, 14, 16]
traits:
  - name: Legendary Resistance (3/Day)
    desc: "If the dragon fails a saving throw, it can choose to succeed instead."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const legres = statblock.abilities.find((a) => a.name === "Legendary Resistance");
    expect(legres).toBeDefined();
    expect(legres?.legendaryResistanceUses).toBe(3);
  });

  it("leaves an ordinary trait's legendaryResistanceUses undefined", () => {
    const markdown = `\`\`\`statblock
name: Test Beast
cr: 1
ac: 12
hp: 20
stats: [14, 12, 14, 4, 10, 6]
traits:
  - name: Keen Smell
    desc: "The beast has advantage on Wisdom (Perception) checks that rely on smell."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const keenSmell = statblock.abilities.find((a) => a.name === "Keen Smell");
    expect(keenSmell?.legendaryResistanceUses).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/statblock-parse.test.ts -t "Legendary Resistance"`
Expected: FAIL (`legres` is `undefined` — `buildAbilities` doesn't special-case the name yet).

- [ ] **Step 3: Implement `extractLegendaryResistanceUses` and wire it into `buildAbilities`**

In `packages/statblock-sync/src/parse.ts`, replace:

```ts
/** The `traits` list becomes passive ability/feature entries. */
function buildAbilities(sb: Statblock): StatblockData["abilities"] {
  return (sb.traits ?? []).map((t) => ({
    name: t.name,
    description: t.desc,
    passive: true,
  }));
}
```

with:

```ts
/**
 * Extract a "(N/Day)" suffix from a trait named "Legendary Resistance" (case-
 * insensitive prefix match), returning the clean name and the parsed count.
 * Same shape as `extractRecharge` below: a name-embedded suffix is stripped
 * and turned into structured data the caller attaches separately.
 */
function extractLegendaryResistanceUses(name: string): { name: string; uses?: number } {
  if (!/^Legendary Resistance\b/i.test(name)) return { name };
  const match = name.match(/\((\d+)\/Day\)/i);
  if (!match?.[1]) return { name };
  return { name: name.replace(match[0], "").trim(), uses: parseInt(match[1], 10) };
}

/** The `traits` list becomes passive ability/feature entries. */
function buildAbilities(sb: Statblock): StatblockData["abilities"] {
  return (sb.traits ?? []).map((t) => {
    const { name, uses } = extractLegendaryResistanceUses(t.name);
    return {
      name,
      description: t.desc,
      passive: true,
      ...(uses !== undefined ? { legendaryResistanceUses: uses } : {}),
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run test/integration/statblock-parse.test.ts`
Expected: PASS (all tests in the file, including the two new ones).

- [ ] **Step 5: Commit**

```bash
git add packages/statblock-sync/src/parse.ts test/integration/statblock-parse.test.ts
git commit -m "feat(statblock-sync): parse Legendary Resistance (N/Day) uses from trait name"
```

---

### Task 3: `to-foundry.ts` — emit `system.resources.legact/legres/lair`

**Files:**
- Modify: `packages/statblock-sync/src/to-foundry.ts`
- Test: `test/integration/statblock-to-foundry.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/statblock-to-foundry.test.ts` (near the existing `it.each(["legendary_actions",...])` test):

```ts
  it("sets resources.legact.max from the count of legendary_actions entries", () => {
    const markdown = `\`\`\`statblock
name: Test Dragon
cr: 10
ac: 18
hp: 150
stats: [20, 10, 18, 10, 14, 16]
legendary_actions:
  - name: Detect
    desc: "The dragon makes a Wisdom (Perception) check."
  - name: Tail Attack
    desc: "Melee Attack Roll: +8, reach 15 ft. Hit: 13 (2d6 + 4) Bludgeoning damage."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const system = actor.system as Record<string, any>;
    expect(system.resources.legact.max).toBe(2);
    expect(system.resources.legact.spent).toBe(0);
  });

  it("honors an explicit legendary_action_count override instead of counting entries", () => {
    const markdown = `\`\`\`statblock
name: Test Dragon
cr: 10
ac: 18
hp: 150
stats: [20, 10, 18, 10, 14, 16]
legendary_action_count: 3
legendary_actions:
  - name: Detect
    desc: "The dragon makes a Wisdom (Perception) check."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const system = actor.system as Record<string, any>;
    expect(system.resources.legact.max).toBe(3);
  });

  it("sets resources.legres.max and a daily-recovery uses block from a Legendary Resistance trait", () => {
    const markdown = `\`\`\`statblock
name: Test Dragon
cr: 10
ac: 18
hp: 150
stats: [20, 10, 18, 10, 14, 16]
traits:
  - name: Legendary Resistance (3/Day)
    desc: "If the dragon fails a saving throw, it can choose to succeed instead."
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const system = actor.system as Record<string, any>;
    expect(system.resources.legres.max).toBe(3);
    expect(system.resources.legres.spent).toBe(0);

    const legres = actor.items.find((i) => i.name === "Legendary Resistance")!;
    expect((legres.system as Record<string, any>).uses).toEqual({
      spent: 0,
      max: "3",
      recovery: [{ period: "day", formula: "", type: "recoverAll" }],
    });
  });

  it("sets resources.lair.initiative to 20 when lair_actions are present, else null", () => {
    const withLair = parseStatblock(`\`\`\`statblock
name: Test Dragon
cr: 10
ac: 18
hp: 150
stats: [20, 10, 18, 10, 14, 16]
lair_actions:
  - name: Volcanic Fissure
    desc: "Dexterity Saving Throw: DC 16, each creature standing in the new fissure. Failure: 10 (3d6) Fire damage."
\`\`\`
`);
    const actorWithLair = statblockToFoundryActor(withLair);
    expect((actorWithLair.system as Record<string, any>).resources.lair).toEqual({
      value: true,
      initiative: 20,
      inside: false,
    });

    const withoutLair = parseStatblock(`\`\`\`statblock
name: Test Beast
cr: 1
ac: 12
hp: 20
stats: [14, 12, 14, 4, 10, 6]
\`\`\`
`);
    const actorWithoutLair = statblockToFoundryActor(withoutLair);
    expect((actorWithoutLair.system as Record<string, any>).resources.lair).toEqual({
      value: false,
      initiative: null,
      inside: false,
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/statblock-to-foundry.test.ts -t "resources"`
Expected: FAIL (`system.resources` is `undefined`).

- [ ] **Step 3: Implement in `to-foundry.ts`**

Add a helper next to `itemUses` in `packages/statblock-sync/src/to-foundry.ts`:

```ts
/** Item-level `uses` for a daily-recovery feature (e.g. Legendary Resistance), else the empty default. */
function dailyUses(max: number): Record<string, unknown> {
  return {
    spent: 0,
    max: String(max),
    recovery: [{ period: "day", formula: "", type: "recoverAll" }],
  };
}
```

In `statblockToFoundryActor`, right before `// Build system object`, compute the three derived values:

```ts
  const legendaryCount = statblock.actions.filter((a) => a.type === "legendary").length;
  const legendaryActionMax = statblock.data.legendary_action_count ?? legendaryCount;
  const legendaryResistance = statblock.abilities.find((a) => a.legendaryResistanceUses !== undefined);
  const hasLairActions = statblock.actions.some((a) => a.type === "lair");
```

Add a `resources` key to the `system` object literal (alongside `abilities`/`skills` at the end of the
object):

```ts
    abilities,
    skills,
    resources: {
      legact: { max: legendaryActionMax, spent: 0 },
      legres: { max: legendaryResistance?.legendaryResistanceUses ?? 0, spent: 0 },
      lair: { value: hasLairActions, initiative: hasLairActions ? 20 : null, inside: false },
    },
  };
```

Change the trait-item loop to pass `dailyUses` for the Legendary Resistance ability:

```ts
  // Add trait features (passive: the "trait" property, no activity)
  for (const ability of statblock.abilities) {
    items.push(
      featItem(ability.name, ability.description, {
        properties: ["trait"],
        ...(ability.legendaryResistanceUses !== undefined
          ? { uses: dailyUses(ability.legendaryResistanceUses) }
          : {}),
      }),
    );
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/statblock-to-foundry.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/statblock-sync/src/to-foundry.ts test/integration/statblock-to-foundry.test.ts
git commit -m "feat(statblock-sync): emit resources.legact/legres/lair on the Foundry actor"
```

---

### Task 4: `verify-npc.ts` — legact/legres/lair checks

**Files:**
- Modify: `packages/statblock-sync/src/verify-npc.ts`
- Test: `test/integration/statblock-verify.test.ts`

- [ ] **Step 1: Write the failing tests**

Add to `test/integration/statblock-verify.test.ts` (a new `describe` block, using the same
`readBackFromConverter`-style pattern already in the file but with a locally-built statblock):

```ts
describe("M5: verifyImportedNpc - legendary/lair resources", () => {
  function readBackWithLegendaryLair() {
    const statblock = parseStatblock(`\`\`\`statblock
name: Test Dragon
cr: 10
ac: 18
hp: 150
stats: [20, 10, 18, 10, 14, 16]
traits:
  - name: Legendary Resistance (3/Day)
    desc: "If the dragon fails a saving throw, it can choose to succeed instead."
legendary_actions:
  - name: Detect
    desc: "The dragon makes a Wisdom (Perception) check."
lair_actions:
  - name: Volcanic Fissure
    desc: "Dexterity Saving Throw: DC 16, each creature standing in the new fissure. Failure: 10 (3d6) Fire damage."
\`\`\`
`);
    const readBack: FoundryActorReadBack = {
      _id: "test000000000000",
      ...(statblockToFoundryActor(statblock) as any),
    };
    return { statblock, readBack };
  }

  it("passes legact/legres/lair checks when resources match the statblock", () => {
    const { statblock, readBack } = readBackWithLegendaryLair();
    const report = verifyImportedNpc(readBack, statblock);
    expect(report.checks.find((c) => c.name.includes("legact"))?.pass).toBe(true);
    expect(report.checks.find((c) => c.name.includes("legres"))?.pass).toBe(true);
    expect(report.checks.find((c) => c.name.includes("lair"))?.pass).toBe(true);
  });

  it("fails the legact check when resources.legact.max is wrong", () => {
    const { statblock, readBack } = readBackWithLegendaryLair();
    (readBack.system as any).resources.legact.max = 0;
    const report = verifyImportedNpc(readBack, statblock);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("legact"))?.pass).toBe(false);
  });

  it("fails the legres check when resources.legres.max is wrong", () => {
    const { statblock, readBack } = readBackWithLegendaryLair();
    (readBack.system as any).resources.legres.max = 0;
    const report = verifyImportedNpc(readBack, statblock);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("legres"))?.pass).toBe(false);
  });

  it("fails the lair-initiative check when it isn't 20", () => {
    const { statblock, readBack } = readBackWithLegendaryLair();
    (readBack.system as any).resources.lair.initiative = null;
    const report = verifyImportedNpc(readBack, statblock);
    expect(report.ok).toBe(false);
    expect(report.checks.find((c) => c.name.includes("lair"))?.pass).toBe(false);
  });

  it("does not add legact/legres/lair checks for a statblock with none of these features", () => {
    const statblock = parseStatblock(`\`\`\`statblock
name: Test Beast
cr: 1
ac: 12
hp: 20
stats: [14, 12, 14, 4, 10, 6]
\`\`\`
`);
    const readBack: FoundryActorReadBack = {
      _id: "test000000000000",
      ...(statblockToFoundryActor(statblock) as any),
    };
    const report = verifyImportedNpc(readBack, statblock);
    expect(report.checks.some((c) => c.name.includes("legact"))).toBe(false);
    expect(report.checks.some((c) => c.name.includes("legres"))).toBe(false);
    expect(report.checks.some((c) => c.name.includes("lair"))).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run test/integration/statblock-verify.test.ts -t "legendary/lair resources"`
Expected: FAIL (no such checks exist yet, so `.find(...)` returns `undefined` and `?.pass` is `undefined`, not `true`).

- [ ] **Step 3: Implement the checks in `verify-npc.ts`**

In `packages/statblock-sync/src/verify-npc.ts`, after the CR check block (`checks.push({ name: "CR matches", ... })`), add:

```ts
  // Legendary actions / legendary resistance / lair-action resources
  const legendaryCount = statblock.actions.filter((a) => a.type === "legendary").length;
  const wantLegact = statblock.data.legendary_action_count ?? legendaryCount;
  if (wantLegact > 0) {
    const gotLegact = system.resources?.legact?.max;
    checks.push({
      name: "Legendary action count (resources.legact.max)",
      pass: gotLegact === wantLegact,
      got: gotLegact,
      want: wantLegact,
    });
  }

  const legendaryResistance = statblock.abilities.find((a) => a.legendaryResistanceUses !== undefined);
  if (legendaryResistance) {
    const gotLegres = system.resources?.legres?.max;
    checks.push({
      name: "Legendary Resistance uses (resources.legres.max)",
      pass: gotLegres === legendaryResistance.legendaryResistanceUses,
      got: gotLegres,
      want: legendaryResistance.legendaryResistanceUses,
    });
  }

  const hasLairActions = statblock.actions.some((a) => a.type === "lair");
  if (hasLairActions) {
    const gotInitiative = system.resources?.lair?.initiative;
    checks.push({
      name: "Lair action initiative (resources.lair.initiative)",
      pass: gotInitiative === 20,
      got: gotInitiative,
      want: 20,
    });
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/statblock-verify.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Commit**

```bash
git add packages/statblock-sync/src/verify-npc.ts test/integration/statblock-verify.test.ts
git commit -m "feat(statblock-sync): verify legact/legres/lair resources on read-back"
```

---

### Task 5: Young Ash Wyrm acceptance fixture

**Files:**
- Create: `test/fixtures/statblock-import/young-ash-wyrm.md`

- [ ] **Step 1: Write the fixture**

```markdown
# Young Ash Wyrm

```statblock
name: Young Ash Wyrm
size: Large
type: dragon
alignment: Chaotic Evil
ac: 18
ac_class: natural armor
hp: 152
hit_dice: 16d10+64
speed: 40 ft., fly 80 ft.
stats: [19, 10, 18, 12, 11, 15]
saves:
  - dexterity: 4
  - constitution: 8
  - wisdom: 4
  - charisma: 6
skillsaves:
  - perception: 8
  - stealth: 4
damage_immunities: fire
senses: blindsight 30 ft., darkvision 120 ft., passive Perception 18
languages: Common, Draconic
cr: 10
traits:
  - name: Legendary Resistance (3/Day)
    desc: "If the wyrm fails a saving throw, it can choose to succeed instead."
actions:
  - name: Multiattack
    desc: "The wyrm makes three attacks: one with its Bite and two with its Claws."
  - name: Bite
    desc: "Melee Attack Roll: +8, reach 10 ft. Hit: 15 (2d10 + 4) Piercing damage plus 4 (1d8) Fire damage."
  - name: Claw
    desc: "Melee Attack Roll: +8, reach 5 ft. Hit: 11 (2d6 + 4) Slashing damage."
  - name: Fire Breath (Recharge 5-6)
    desc: "Dexterity Saving Throw: DC 16, each creature in a 60-foot line. Failure: 45 (13d6) Fire damage. Success: Half damage."
legendary_actions:
  - name: Detect
    desc: "The wyrm makes a Wisdom (Perception) check."
  - name: Tail Attack
    desc: "Melee Attack Roll: +8, reach 15 ft. Hit: 13 (2d6 + 4) Bludgeoning damage."
  - name: Wing Attack (Costs 2 Actions)
    desc: "Dexterity Saving Throw: DC 16, each creature within 10 feet of the wyrm. Failure: 13 (2d6 + 4) Bludgeoning damage and knocked prone."
lair_actions:
  - name: Volcanic Fissure
    desc: "The wyrm causes a 10-foot-radius fissure to open at a point it can see within 120 feet. Dexterity Saving Throw: DC 14, each creature standing in the new fissure. Failure: 10 (3d6) Fire damage."
```

A young ash wyrm, its scales the grey of cooled cinders, nests where old wildfires burned hottest.
```

Save this to `test/fixtures/statblock-import/young-ash-wyrm.md` (no PNG needed — `duskfang-bog-wyrm.md`
has no `image:` field either, and image is optional per `schema.ts`).

- [ ] **Step 2: Lint it**

Run: `npm run lint:statblock -- test/fixtures/statblock-import/young-ash-wyrm.md`
Expected: `LINT PASSED` (2024-only grammar: attack rolls use "Melee Attack Roll: +N", saves lead with the
ability name "Dexterity Saving Throw: DC N"). If it fails, fix the flagged line per the lint's own message
before proceeding — do not hand-wave past a FAIL.

- [ ] **Step 3: Commit**

```bash
git add test/fixtures/statblock-import/young-ash-wyrm.md
git commit -m "test(statblock-sync): add Young Ash Wyrm legendary+lair+resistance fixture"
```

---

### Task 6: Mock end-to-end test for Young Ash Wyrm

**Files:**
- Modify: `test/integration/statblock-import.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `test/integration/statblock-import.test.ts`, inside the existing
`describe("importNpc: Tier 1 compendium match wired into the import pipeline", ...)` block (after the
Duskfang test):

```ts
  it("imports a homebrew legendary+lair+resistance NPC end-to-end with resources set", async () => {
    const mock = new MockFoundry();
    const transport = new MockTransport(mock);
    const statblock = loadStatblock("young-ash-wyrm.md");

    const result = await importNpc(statblock, realDeps(transport));

    expect(result.tier).toBe(3); // no compendium entry for a homebrew dragon
    const actors = mock.documents("Actor") as Array<{
      _id: string;
      name: string;
      system: Record<string, any>;
      items?: Array<{ name: string; type: string; system?: Record<string, any> }>;
    }>;
    const created = actors.find((a) => a._id === result.actorId)!;
    expect(created.name).toBe("Young Ash Wyrm");

    expect(created.system.resources.legact).toEqual({ max: 3, spent: 0 });
    expect(created.system.resources.legres).toEqual({ max: 3, spent: 0 });
    expect(created.system.resources.lair).toEqual({ value: true, initiative: 20, inside: false });

    const legres = created.items!.find((i) => i.name === "Legendary Resistance")!;
    expect(legres.system!.uses).toEqual({
      spent: 0,
      max: "3",
      recovery: [{ period: "day", formula: "", type: "recoverAll" }],
    });

    // "Wing Attack (Costs 2 Actions)" is a known limitation (see plan doc's
    // non-goals): dnd5e's sheet tracks total legendary-action budget, not a
    // per-action cost, so the name/cost text is parse-and-ignore for now.
    const wingAttack = created.items!.find((i) => i.name === "Wing Attack");
    expect(wingAttack).toBeDefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/statblock-import.test.ts -t "resources set"`
Expected: FAIL until Tasks 1-5 are all in place (this test depends on all of them). If Tasks 1-5 are
already committed, this should already pass — run it to confirm before moving on, and treat any
failure as a real regression to investigate, not something to paper over.

- [ ] **Step 3: Run the whole suite + typecheck (Part A verification gate)**

Run: `npm run typecheck && npm test`
Expected: PASS, no regressions anywhere in the repo.

- [ ] **Step 4: Commit**

```bash
git add test/integration/statblock-import.test.ts
git commit -m "test(statblock-sync): end-to-end mock test for Young Ash Wyrm resources"
```

---

### Task 7 (Part A live pass): live-Foundry verification

**Files:** none (manual/live verification only, using the `mcp__foundry__*` tools against the connected
Forge/local world per the "Forge live-test setup" memory).

- [ ] **Step 1:** Use `mcp__foundry__create_document` (or replicate `importNpc`'s Tier-3 path manually) to
  create the Young Ash Wyrm actor in the live world from the fixture's converted JSON
  (`statblockToFoundryActor` output — can be produced via a small throwaway script using the built
  `@foundry-mcp-bridge/statblock-sync` package, or by hand-copying the fixture's expected fields).

- [ ] **Step 2:** Use `mcp__foundry__find_documents` to read the actor back and confirm:
  - `system.resources.legact.max === 3` and the sheet shows a "Legendary Actions: 3" tracker.
  - `system.resources.legres.max === 3` and the "Legendary Resistance" item shows "3/3 uses" on the sheet.
  - `system.resources.lair.initiative === 20`.
  - If the "day" recovery period shape (Task 3) turns out to render wrong in the real sheet (e.g. the
    resistance uses don't show as expected), that's the signal the guessed `recovery` shape needs
    correcting — re-open Task 3, adjust `dailyUses`, re-run Tasks 3/4/6's tests, and re-verify live. Do
    not consider Part A done until the sheet actually reflects these values live.

- [ ] **Step 3:** Report the live-verification result (pass/fail per item above) before starting Part B —
  per the plan doc's own sequencing rule, Part B must not start until Part A's live pass is green.

---

## Part B — Spellcasting

### Task 8: New protocol command — `packages/shared/src/protocol.ts`

**Files:**
- Modify: `packages/shared/src/protocol.ts`

- [ ] **Step 1: Add the command schema**

In `packages/shared/src/protocol.ts`, immediately after `ImportFromCompendiumCommand`:

```ts
export const ImportEmbeddedFromCompendiumEntry = z.object({
  uuid: z.string().min(1),
  /** Optional dot-notation patch applied to this entry's cloned data. */
  patch: DocumentData.optional(),
});
export type ImportEmbeddedFromCompendiumEntry = z.infer<typeof ImportEmbeddedFromCompendiumEntry>;

export const ImportEmbeddedFromCompendiumCommand = z.object({
  action: z.literal("importEmbeddedFromCompendium"),
  parentType: DocumentType,
  parentId: z.string().min(1),
  /** e.g. "Item" (spells cloned onto an actor). */
  embeddedName: z.string().min(1),
  /** Batched so a whole spell list attaches in one round-trip. */
  uuids: z.array(ImportEmbeddedFromCompendiumEntry).min(1),
});
export type ImportEmbeddedFromCompendiumCommand = z.infer<typeof ImportEmbeddedFromCompendiumCommand>;
```

- [ ] **Step 2: Add it to the `Command` discriminated union**

```ts
export const Command = z.discriminatedUnion("action", [
  CreateCommand,
  UpdateCommand,
  DeleteCommand,
  DuplicateCommand,
  CreateEmbeddedCommand,
  UpdateEmbeddedCommand,
  DeleteEmbeddedCommand,
  FindCommand,
  CreateQuestCommand,
  UpdateQuestCommand,
  DeleteQuestCommand,
  GetWorldInfoCommand,
  UploadAssetCommand,
  BrowseAssetsCommand,
  BatchUploadAssetsCommand,
  SearchCompendiumCommand,
  ImportFromCompendiumCommand,
  ImportEmbeddedFromCompendiumCommand,
]);
```

- [ ] **Step 3: Build the shared package**

Run: `npm run build`
Expected: PASS (this is a pure additive zod schema change; no existing consumer breaks yet since nothing
dispatches on it).

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/protocol.ts
git commit -m "feat(shared): add importEmbeddedFromCompendium command schema"
```

---

### Task 9: `protocol-executor.ts` — interface + dispatch

**Files:**
- Modify: `packages/foundry-module/src/protocol-executor.ts`

- [ ] **Step 1: Add the method to `FoundryDocumentApi`**

Right after `importFromCompendium(...)` in the interface:

```ts
  importEmbeddedFromCompendium(
    parentType: DocumentType,
    parentId: string,
    embeddedName: string,
    uuids: Array<{ uuid: string; patch?: DocData }>,
    opts: ExecuteOptions,
  ): Promise<DocData[]>;
```

- [ ] **Step 2: Add the dispatch case**

Right after the `case "importFromCompendium":` arm in `dispatch()`:

```ts
    case "importEmbeddedFromCompendium":
      return api.importEmbeddedFromCompendium(
        command.parentType,
        command.parentId,
        command.embeddedName,
        command.uuids,
        opts,
      );
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: FAIL — every implementer of `FoundryDocumentApi` (foundry-runtime.ts, mock-foundry-api.ts,
relay-client.test.ts's `stubApi`) is now missing the method. This is expected and intentional (TDD-by-type-
error); Tasks 10-12 fix each one. Confirm the errors are exactly "missing property
`importEmbeddedFromCompendium`" in those three files and nowhere else before moving on.

- [ ] **Step 4: Commit**

```bash
git add packages/foundry-module/src/protocol-executor.ts
git commit -m "feat(foundry-module): dispatch importEmbeddedFromCompendium to FoundryDocumentApi"
```

---

### Task 10: `foundry-runtime.ts` — real implementation

**Files:**
- Modify: `packages/foundry-module/src/foundry-runtime.ts`

- [ ] **Step 1: Implement it**

Add right after `importFromCompendium(...)` in `createFoundryRuntimeApi()`'s returned object:

```ts
    async importEmbeddedFromCompendium(parentType, parentId, embeddedName, uuids, opts) {
      const parent = requireDoc(parentType, parentId);
      const datas: DocData[] = [];
      for (const entry of uuids) {
        let source;
        try {
          source = await fromUuid(entry.uuid);
        } catch (e) {
          throw new CommandExecutionError(
            "NOT_FOUND",
            `compendium entry ${entry.uuid} not found`,
            { cause: e instanceof Error ? e.message : String(e) },
          );
        }
        if (!source) {
          throw new CommandExecutionError("NOT_FOUND", `compendium entry ${entry.uuid} not found`);
        }
        datas.push(entry.patch ? applyUpdate(source.toObject(), entry.patch) : source.toObject());
      }
      if (opts.dryRun) return datas;
      const created = await parent.createEmbeddedDocuments(embeddedName, datas);
      return created.map((d: any) => d.toObject());
    },
```

`DocData` needs importing as a type in this file — check the existing import line
(`import type { ExecuteOptions, FindSelector, FoundryDocumentApi, ... } from "./protocol-executor.js";`)
and add `DocData` to it.

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: `foundry-runtime.ts`'s error from Task 9 is now gone; `mock-foundry-api.ts` and
`relay-client.test.ts` still show the missing-method error.

- [ ] **Step 3: Commit**

```bash
git add packages/foundry-module/src/foundry-runtime.ts
git commit -m "feat(foundry-module): implement importEmbeddedFromCompendium against real Foundry"
```

---

### Task 11: `mock-foundry.ts` + `mock-foundry-api.ts` + `relay-client.test.ts` stub

**Files:**
- Modify: `test/integration/mock-foundry.ts`
- Modify: `test/integration/mock-foundry-api.ts`
- Modify: `packages/foundry-module/src/relay-client.test.ts`

- [ ] **Step 1: `mock-foundry.ts` — dispatch case + private method**

Add the case to the `dispatch()` switch, right after `case "importFromCompendium":`:

```ts
      case "importEmbeddedFromCompendium":
        return this.importEmbeddedFromCompendium(id, command, dryRun);
```

Add the private method, right after `private importFromCompendium(...)`:

```ts
  private importEmbeddedFromCompendium(
    id: string,
    cmd: Extract<Command, { action: "importEmbeddedFromCompendium" }>,
    dryRun: boolean,
  ): CommandResult {
    const resolved = this.resolveEmbedded(id, cmd);
    if ("error" in resolved) return resolved.error;
    const created: Json[] = [];
    for (const entry of cmd.uuids) {
      const record = this.compendium.get(entry.uuid);
      if (!record) return err(id, "NOT_FOUND", `compendium entry ${entry.uuid} not found`);
      // Deep-clone for the same reason importFromCompendium does: mutating the
      // embedded copy must never reach back into the shared compendium record.
      const data = entry.patch ? applyUpdate(record.data, entry.patch) : structuredClone(record.data);
      created.push({ ...data, _id: randomID() });
    }
    if (dryRun) return ok(id, created.map((c) => ({ ...c, _dryRun: true })));
    resolved.arr.push(...created);
    return ok(id, created);
  }
```

- [ ] **Step 2: `mock-foundry-api.ts` — adapter method**

Add right after `importFromCompendium(...)`:

```ts
    async importEmbeddedFromCompendium(parentType, parentId, embeddedName, uuids, opts) {
      return (await run(
        { action: "importEmbeddedFromCompendium", parentType, parentId, embeddedName, uuids },
        opts,
      )) as DocData[];
    },
```

- [ ] **Step 3: `relay-client.test.ts` — trivial stub**

In `stubApi()`, add right after `importFromCompendium(...)`:

```ts
    async importEmbeddedFromCompendium(_p, _id, _name, uuids) {
      return uuids.map((u) => ({ ...u.patch, _id: "imported-embedded" }));
    },
```

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: PASS — all three `FoundryDocumentApi` implementers now satisfy the interface.

- [ ] **Step 5: Mock-level round-trip test**

Add to `test/integration/mock-foundry.test.ts` (mirroring the existing `createEmbedded` round-trip test
in that file):

```ts
describe("importEmbeddedFromCompendium", () => {
  it("clones a compendium entry as a new embedded document on the parent", async () => {
    const mock = new MockFoundry();
    mock.compendium.set("Compendium.dnd5e.spells24.fire-bolt", {
      documentType: "Item",
      pack: "dnd5e.spells24",
      data: { name: "Fire Bolt", type: "spell", system: { level: 0 } },
    });
    await mock.execute({
      id: "seed-actor",
      protocolVersion: PROTOCOL_VERSION,
      dryRun: false,
      command: { action: "create", documentType: "Actor", data: { _id: "a1", name: "Wizard" }, keepId: true },
    });

    const result = await mock.execute({
      id: "x1",
      protocolVersion: PROTOCOL_VERSION,
      dryRun: false,
      command: {
        action: "importEmbeddedFromCompendium",
        parentType: "Actor",
        parentId: "a1",
        embeddedName: "Item",
        uuids: [{ uuid: "Compendium.dnd5e.spells24.fire-bolt" }],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const created = result.data as Array<{ _id: string; name: string }>;
    expect(created).toHaveLength(1);
    expect(created[0]!.name).toBe("Fire Bolt");

    const actor = (mock as any).get?.("Actor", "a1") ?? mock.documents("Actor").find((a: any) => a._id === "a1");
    expect(actor.items).toHaveLength(1);
    expect(actor.items[0]._id).toBe(created[0]!.name && created[0]!._id);
  });

  it("returns NOT_FOUND for an unknown compendium uuid", async () => {
    const mock = new MockFoundry();
    await mock.execute({
      id: "seed-actor",
      protocolVersion: PROTOCOL_VERSION,
      dryRun: false,
      command: { action: "create", documentType: "Actor", data: { _id: "a1", name: "Wizard" }, keepId: true },
    });
    const result = await mock.execute({
      id: "x1",
      protocolVersion: PROTOCOL_VERSION,
      dryRun: false,
      command: {
        action: "importEmbeddedFromCompendium",
        parentType: "Actor",
        parentId: "a1",
        embeddedName: "Item",
        uuids: [{ uuid: "Compendium.dnd5e.spells24.nonexistent" }],
      },
    });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.code).toBe("NOT_FOUND");
  });
});
```

Note: `mock.get` is private — replace that awkward line with the simpler, already-public
`mock.documents("Actor")` lookup used in the second half of the expression; adjust while writing so the
test only uses public members (`mock.documents(...)`, `mock.compendium`, `mock.execute(...)`).

- [ ] **Step 6: Run tests**

Run: `npx vitest run test/integration/mock-foundry.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add test/integration/mock-foundry.ts test/integration/mock-foundry-api.ts \
  packages/foundry-module/src/relay-client.test.ts test/integration/mock-foundry.test.ts
git commit -m "feat(mock-foundry): support importEmbeddedFromCompendium"
```

---

### Task 12: `module-executor.test.ts` — executor-level test

**Files:**
- Modify: `test/integration/module-executor.test.ts`

- [ ] **Step 1: Write the test**

Mirroring the file's existing `executeCommand` direct-call pattern for `createEmbedded`, add a test that
seeds a compendium entry on the `MockFoundry` instance backing `mockFoundryApi(mock)`, then calls
`executeCommand` with `action: "importEmbeddedFromCompendium"` and asserts the result's `ok`/`data` shape
and that the parent's `items` array grew by one. Use the same `env()`/`setup()` helpers already in the file.

- [ ] **Step 2: Run it**

Run: `npx vitest run test/integration/module-executor.test.ts`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add test/integration/module-executor.test.ts
git commit -m "test(foundry-module): executeCommand round-trip for importEmbeddedFromCompendium"
```

---

### Task 13: `reliability.ts` — `importEmbeddedFromCompendiumReliable`

**Files:**
- Modify: `packages/mcp-server/src/reliability.ts`

- [ ] **Step 1: Add the exhaustive `commandSummary` case**

In `commandSummary()`, right after the `case "importFromCompendium":` arm:

```ts
    case "importEmbeddedFromCompendium":
      return `${c.parentType}/${c.embeddedName} parent=${c.parentId} n=${c.uuids.length}`;
```

(Without this, `npm run typecheck` fails — the switch is exhaustive over `Command["action"]` with no
`default`, so a new union member always needs a case here.)

- [ ] **Step 2: Add the reliability function**

Add right after `importFromCompendiumReliable`:

```ts
export interface ImportEmbeddedFromCompendiumInput {
  parentType: DocumentType;
  parentId: string;
  embeddedName: string;
  uuids: Array<{ uuid: string; patch?: Json }>;
}

export async function importEmbeddedFromCompendiumReliable(
  transport: RelayTransport,
  input: ImportEmbeddedFromCompendiumInput,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // Same emptiness guard as importFromCompendiumReliable, applied per-entry:
  // an entry's patch is optional (undefined = clone as-is), but a supplied-
  // and-empty patch silently drops caller intent (see isEmptyDiff).
  const badEntry = input.uuids.find((u) => isEmptyDiff(u.patch));
  if (badEntry) {
    return validationFailure(`patch for uuid ${badEntry.uuid} has no safe fields to apply`);
  }

  return runEmbeddedMutation(
    transport,
    {
      write: {
        action: "importEmbeddedFromCompendium",
        parentType: input.parentType,
        parentId: input.parentId,
        embeddedName: input.embeddedName,
        uuids: input.uuids,
      },
      parentType: input.parentType,
      parentId: input.parentId,
      noun: "created",
      verify: (parent, written) => {
        const entries = embeddedEntries(parent, input.embeddedName);
        if (!entries) return true;
        const ids = written.map(idOf).filter((id): id is string => !!id);
        if (ids.length === 0) return true;
        const present = new Set(entries.map(idOf));
        return ids.every((id) => present.has(id));
      },
      deriveRollback: (written) => {
        const ids = written.map(idOf).filter((id): id is string => !!id);
        return ids.length
          ? {
              action: "deleteEmbedded",
              parentType: input.parentType,
              parentId: input.parentId,
              embeddedName: input.embeddedName,
              ids,
            }
          : null;
      },
    },
    opts,
    [],
  );
}
```

- [ ] **Step 3: Typecheck**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/src/reliability.ts
git commit -m "feat(mcp-server): add importEmbeddedFromCompendiumReliable pipeline"
```

---

### Task 14: `tools.ts` + `server.ts` — register the tool

**Files:**
- Modify: `packages/mcp-server/src/tools.ts`
- Modify: `packages/mcp-server/src/server.ts`

- [ ] **Step 1: `tools.ts` — shape + run function**

Add near `ImportFromCompendiumShape`/`runImportFromCompendium` (import `importEmbeddedFromCompendiumReliable`
into the `reliability.js` import block at the top of the file too):

```ts
// --- import_embedded_from_compendium ----------------------------------------

export const ImportEmbeddedFromCompendiumShape = {
  parentType: DocumentType,
  parentId: z.string().min(1),
  embeddedName: z.string().min(1),
  uuids: z.array(z.object({ uuid: z.string().min(1), patch: documentData.optional() })).min(1),
  fields: fieldsParam,
  full: fullParam,
};
const ImportEmbeddedFromCompendium = z.object(ImportEmbeddedFromCompendiumShape);
export type ImportEmbeddedFromCompendiumArgs = z.infer<typeof ImportEmbeddedFromCompendium>;

export async function runImportEmbeddedFromCompendium(
  transport: RelayTransport,
  args: ImportEmbeddedFromCompendiumArgs,
  opts: PipelineOptions = {},
): Promise<ToolOutcome> {
  // Drop unsafe dot-path keys from each entry's patch, consistent with
  // import_from_compendium's single patch.
  const uuids = args.uuids.map((u) => ({
    ...u,
    patch: u.patch ? filterUnsafePaths(u.patch) : u.patch,
  }));
  return projectEcho(
    await importEmbeddedFromCompendiumReliable(transport, { ...args, uuids }, opts),
    args.fields,
    args.full,
  );
}
```

- [ ] **Step 2: `server.ts` — import + register**

Add `ImportEmbeddedFromCompendiumShape` and `runImportEmbeddedFromCompendium` to the import block from
`./tools.js`, then register right after the `import_from_compendium` registration:

```ts
  register(
    "import_embedded_from_compendium",
    "Clone one or more compendium entries as embedded documents on a parent (e.g. spells onto an actor). Runs the full reliability pipeline with read-back of the parent. Rejects with VALIDATION if any entry's patch is supplied but has no safe fields to apply. Echo (the created entries) is slim by default; pass full:true or fields:[...] to change what's returned.",
    ImportEmbeddedFromCompendiumShape,
    runImportEmbeddedFromCompendium,
  );
```

- [ ] **Step 3: Typecheck + build**

Run: `npm run typecheck && npm run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/src/tools.ts packages/mcp-server/src/server.ts
git commit -m "feat(mcp-server): register import_embedded_from_compendium tool"
```

---

### Task 15: `mcp-tools.test.ts` — tool pipeline tests

**Files:**
- Modify: `test/integration/mcp-tools.test.ts`

- [ ] **Step 1: Write the tests**

Add a new `describe("import_embedded_from_compendium pipeline", ...)` block after the existing
`search_compendium / import_from_compendium pipeline` block. Seed a spell compendium entry directly on
`mock.compendium` (same pattern as Task 11's mock-level test) plus an Actor via `seed()`, then cover:

```ts
describe("import_embedded_from_compendium pipeline", () => {
  const SPELL_UUID = "Compendium.dnd5e.spells24.fire-bolt";

  function seedSpellAndActor(mock: MockFoundry) {
    mock.compendium.set(SPELL_UUID, {
      documentType: "Item",
      pack: "dnd5e.spells24",
      data: { name: "Fire Bolt", type: "spell", system: { level: 0 } },
    });
    return seed(mock, { action: "create", documentType: "Actor", data: { _id: "a1", name: "Wizard" }, keepId: true });
  }

  it("clones a compendium spell as an embedded Item on the actor", async () => {
    const { mock, transport } = setup();
    await seedSpellAndActor(mock);
    const out = await runImportEmbeddedFromCompendium(transport, {
      parentType: "Actor",
      parentId: "a1",
      embeddedName: "Item",
      uuids: [{ uuid: SPELL_UUID }],
      fields: ["_id", "name", "type"],
    });
    expect(out.ok).toBe(true);
    expect(out.steps).toEqual(["dry-run", "write", "read-back"]);
    if (!out.ok) return;
    const created = out.data as Array<{ name: string; type: string }>;
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ name: "Fire Bolt", type: "spell" });
  });

  it("returns NOT_FOUND for an unknown uuid", async () => {
    const { mock, transport } = setup();
    await seedSpellAndActor(mock);
    const out = await runImportEmbeddedFromCompendium(transport, {
      parentType: "Actor",
      parentId: "a1",
      embeddedName: "Item",
      uuids: [{ uuid: "Compendium.dnd5e.spells24.nonexistent" }],
    });
    expectErr(out, "NOT_FOUND");
  });

  it("rejects a supplied-but-empty patch with VALIDATION", async () => {
    const { mock, transport } = setup();
    await seedSpellAndActor(mock);
    const out = await runImportEmbeddedFromCompendium(transport, {
      parentType: "Actor",
      parentId: "a1",
      embeddedName: "Item",
      uuids: [{ uuid: SPELL_UUID, patch: {} }],
    });
    expectErr(out, "VALIDATION");
  });

  it("rolls back the created embedded items when parent read-back fails", async () => {
    const { mock, transport } = setup();
    await seedSpellAndActor(mock);
    transport.failFindAtCall = 1;
    const out = await runImportEmbeddedFromCompendium(transport, {
      parentType: "Actor",
      parentId: "a1",
      embeddedName: "Item",
      uuids: [{ uuid: SPELL_UUID }],
    });
    expectErr(out, "READBACK_MISMATCH");
    expect(out.steps).toContain("rollback");
    const actor = mock.documents("Actor").find((a: any) => a._id === "a1") as { items: unknown[] };
    expect(actor.items.length).toBe(0);
  });
});
```

Add `runImportEmbeddedFromCompendium` and `MockFoundry`'s `CompendiumRecord`-shaped seeding to the file's
import block as needed (the type for `mock.compendium.set`'s second argument isn't exported today — if
`CompendiumRecord` isn't exported from `mock-foundry.ts`, either export it or inline the object literal
without an explicit type annotation, letting TS infer it against the `Map`'s value type).

- [ ] **Step 2: Run tests**

Run: `npx vitest run test/integration/mcp-tools.test.ts -t "import_embedded_from_compendium"`
Expected: PASS.

- [ ] **Step 3: Full verification gate**

Run: `npm run typecheck && npm test`
Expected: PASS, no regressions.

- [ ] **Step 4: Commit**

```bash
git add test/integration/mcp-tools.test.ts test/integration/mock-foundry.ts
git commit -m "test(mcp-server): pipeline tests for import_embedded_from_compendium"
```

---

### Task 16: `schema.ts` + `grammar.ts` — `spellcasting` shape and `parseSpellcastingTrait`

**Files:**
- Modify: `packages/statblock-sync/src/schema.ts`
- Modify: `packages/statblock-sync/src/grammar.ts`
- Test: `test/integration/statblock-grammar.test.ts`

- [ ] **Step 1: Add the `spellcasting` shape to `StatblockData`**

In `schema.ts`, add a new top-level field to `StatblockData` (after `actions`):

```ts
  /** Parsed from a "Spellcasting" trait's raw text, if present (innate spellcasting is out of scope). */
  spellcasting?: {
    /** Three-letter ability key, e.g. "int". */
    ability: string;
    dc: number;
    attackBonus: number;
    levels: Array<{
      /** 0 = cantrips. */
      level: number;
      /** Absent for cantrips (at will). */
      slots?: number;
      spellNames: string[];
    }>;
  };
```

- [ ] **Step 2: Write the failing grammar test**

Add to `test/integration/statblock-grammar.test.ts`:

```ts
  it("parses a 2024-style Spellcasting trait into ability/dc/attackBonus/levels", () => {
    const desc =
      "The archmage is a level 18 spellcaster. Its spellcasting ability is Intelligence " +
      "(spell save DC 17, +9 to hit with spell attacks). The archmage has the following wizard " +
      "spells prepared: Cantrips (at will): fire bolt, light, mage hand, prestidigitation " +
      "1st level (4 slots): detect magic, mage armor, magic missile, shield " +
      "2nd level (3 slots): misty step, suggestion " +
      "3rd level (3 slots): counterspell, fireball, fly " +
      "4th level (3 slots): dimension door, greater invisibility " +
      "5th level (1 slot): cone of cold";

    const parsed = parseSpellcastingTrait(desc);
    expect(parsed).toBeDefined();
    expect(parsed?.ability).toBe("int");
    expect(parsed?.dc).toBe(17);
    expect(parsed?.attackBonus).toBe(9);
    expect(parsed?.levels).toEqual([
      { level: 0, slots: undefined, spellNames: ["fire bolt", "light", "mage hand", "prestidigitation"] },
      { level: 1, slots: 4, spellNames: ["detect magic", "mage armor", "magic missile", "shield"] },
      { level: 2, slots: 3, spellNames: ["misty step", "suggestion"] },
      { level: 3, slots: 3, spellNames: ["counterspell", "fireball", "fly"] },
      { level: 4, slots: 3, spellNames: ["dimension door", "greater invisibility"] },
      { level: 5, slots: 1, spellNames: ["cone of cold"] },
    ]);
  });

  it("also parses correctly when the trait text has real embedded newlines (YAML literal-block style)", () => {
    // Guards against a parser that only works when YAML's double-quoted
    // folding has collapsed everything to one line — a `|`-style YAML block
    // scalar (or hand-constructed multi-line string) keeps real newlines, and
    // the parser must handle both.
    const desc =
      "Spellcasting ability is Wisdom (spell save DC 15, +7 to hit with spell attacks).\n" +
      "Cantrips (at will): guidance, sacred flame\n" +
      "1st level (4 slots): bless, cure wounds\n";
    const parsed = parseSpellcastingTrait(desc);
    expect(parsed?.ability).toBe("wis");
    expect(parsed?.levels).toEqual([
      { level: 0, slots: undefined, spellNames: ["guidance", "sacred flame"] },
      { level: 1, slots: 4, spellNames: ["bless", "cure wounds"] },
    ]);
  });

  it("returns undefined for text with no spellcasting DC/attack/ability markers", () => {
    expect(parseSpellcastingTrait("The creature can breathe fire.")).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/statblock-grammar.test.ts -t "Spellcasting"`
Expected: FAIL (`parseSpellcastingTrait` doesn't exist — import error / undefined).

- [ ] **Step 3: Implement `parseSpellcastingTrait` in `grammar.ts`**

Add near the bottom of `packages/statblock-sync/src/grammar.ts` (export it alongside `parseAttackAction`/
`parseSaveAction`):

```ts
/**
 * Parse a "Spellcasting" trait's raw text into ability/DC/attack-bonus and
 * per-level spell lists. Header-anchored (not line-anchored): YAML's
 * double-quoted folded scalars collapse real line breaks into single spaces
 * when parsed, so a level list may arrive as one long space-separated string
 * with no newlines at all — this must work whether or not newlines survive.
 * Innate spellcasting ("1/day each: ...") is a different trait shape and is
 * intentionally NOT recognized here (see docs/statblock-legendary-lair-spellcasting-plan.md,
 * "Non-goals").
 */
export function parseSpellcastingTrait(
  desc: string
): StatblockData["spellcasting"] | undefined {
  const normalized = stripMarkdown(desc).replace(/\s+/g, " ").trim();

  const dcMatch = normalized.match(/spell save DC\s*(\d+)/i);
  const bonusMatch = normalized.match(/\+(\d+)\s+to hit with spell attacks/i);
  const abilityMatch = normalized.match(/spellcasting ability is (\w+)/i);
  if (!dcMatch?.[1] || !bonusMatch?.[1] || !abilityMatch?.[1]) return undefined;

  const HEADER_RE = /(Cantrips\s*\(at will\)|(\d)(?:st|nd|rd|th)\s*level(?:\s*\((\d+)\s*slots?\))?)\s*:\s*/gi;
  const headers: Array<{ index: number; end: number; level: number; slots?: number }> = [];
  let hm: RegExpExecArray | null;
  while ((hm = HEADER_RE.exec(normalized)) !== null) {
    headers.push({
      index: hm.index,
      end: hm.index + hm[0].length,
      level: hm[2] ? parseInt(hm[2], 10) : 0,
      slots: hm[3] ? parseInt(hm[3], 10) : undefined,
    });
  }

  const levels = headers.map((h, i) => {
    const stop = i + 1 < headers.length ? headers[i + 1]!.index : normalized.length;
    const body = normalized.slice(h.end, stop).replace(/\.\s*$/, "").trim();
    return {
      level: h.level,
      slots: h.slots,
      spellNames: body.split(",").map((s) => s.trim()).filter(Boolean),
    };
  });

  return {
    ability: abilityMatch[1].toLowerCase().substring(0, 3),
    dc: parseInt(dcMatch[1], 10),
    attackBonus: parseInt(bonusMatch[1], 10),
    levels,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/statblock-grammar.test.ts`
Expected: PASS (all tests in the file).

- [ ] **Step 5: Wire it into `parse.ts`**

In `packages/statblock-sync/src/parse.ts`, add the import (`parseSpellcastingTrait` from `./grammar.js`),
add a `buildSpellcasting` function next to `buildAbilities`:

```ts
/** The "Spellcasting" trait (if any) becomes the actor-level spellcasting shape. */
function buildSpellcasting(sb: Statblock): StatblockData["spellcasting"] {
  const trait = (sb.traits ?? []).find((t) => /^spellcasting$/i.test(t.name));
  return trait ? parseSpellcastingTrait(trait.desc) : undefined;
}
```

and add `spellcasting: buildSpellcasting(sb),` to the object returned by `parseStatblock`.

- [ ] **Step 6: Parse-level test**

Add to `test/integration/statblock-parse.test.ts`:

```ts
  it("parses a Spellcasting trait into statblock.spellcasting", () => {
    const markdown = `\`\`\`statblock
name: Test Archmage
cr: 12
ac: 12
hp: 100
stats: [10, 14, 12, 20, 15, 16]
traits:
  - name: Spellcasting
    desc: "The archmage is a level 18 spellcaster. Its spellcasting ability is Intelligence (spell save DC 17, +9 to hit with spell attacks). The archmage has the following wizard spells prepared: Cantrips (at will): fire bolt, light 1st level (4 slots): detect magic, shield"
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    expect(statblock.spellcasting).toBeDefined();
    expect(statblock.spellcasting?.ability).toBe("int");
    expect(statblock.spellcasting?.levels[0]).toEqual({ level: 0, slots: undefined, spellNames: ["fire bolt", "light"] });
  });

  it("leaves statblock.spellcasting undefined with no Spellcasting trait", () => {
    const statblock = parseStatblock(`\`\`\`statblock
name: Test Beast
cr: 1
ac: 12
hp: 20
stats: [14, 12, 14, 4, 10, 6]
\`\`\`
`);
    expect(statblock.spellcasting).toBeUndefined();
  });
```

Run: `npx vitest run test/integration/statblock-parse.test.ts`
Expected: PASS.

- [ ] **Step 7: Typecheck + commit**

Run: `npm run typecheck`
Expected: PASS.

```bash
git add packages/statblock-sync/src/schema.ts packages/statblock-sync/src/grammar.ts \
  packages/statblock-sync/src/parse.ts test/integration/statblock-grammar.test.ts \
  test/integration/statblock-parse.test.ts
git commit -m "feat(statblock-sync): parse Spellcasting trait into statblock.spellcasting"
```

---

### Task 17: Extract a real spellcaster fixture (live, before landing `to-foundry.ts` fields)

**Files:** none committed by this task itself — it produces the ground-truth data Task 18 codes against.

This mirrors the "extract, don't guess" rule `test/fixtures/dnd5e-53-schema/` was built under, and the
source plan's own instruction to "confirm exact dnd5e 5.3.3 field name before landing." It requires the
live-Foundry access set up per the "Forge live-test setup" memory.

- [ ] **Step 1:** Use `mcp__foundry__search_compendium` with `documentType: "Actor"`, `nameQuery: "Archmage"`
  (or any other 2024 spellcasting NPC available in `dnd5e.actors24`/`monsterfeatures24` on the connected
  world) to find a UUID.

- [ ] **Step 2:** Use `mcp__foundry__import_from_compendium` to clone it into the world (a throwaway import
  — delete it after, or leave it if the world is a scratch/test world).

- [ ] **Step 3:** Use `mcp__foundry__find_documents` to read the actor back in full and inspect:
  - `system.attributes.spellcasting` — confirm it's the 3-letter ability key as assumed.
  - `system.spells.spellN` — confirm it's exactly `{ value, override }` with no `max`, as the
    `white-dragon-wyrmling-full.json` fixture already suggested (Task 18 depends on this being right).
  - Whether there's any settable DC/attack-bonus override field anywhere in `system` (e.g. under
    `bonuses.spell`) — if one exists and is populated on the real Archmage, note its exact shape; if the
    official actor instead just relies on ability score + proficiency bonus deriving the printed DC/attack
    (as Task 19's acceptance NPC does), that confirms the "derive, don't override" approach is correct and
    no such field is needed.

- [ ] **Step 4:** If anything contradicts the assumptions in this plan (correction #4/#5 at the top of this
  file), stop and re-open Task 18 with the corrected shape before writing `to-foundry.ts` code — don't
  proceed on a guess once ground truth is available.

---

### Task 18: `to-foundry.ts` — actor-level spellcasting fields + slot buckets

**Files:**
- Modify: `packages/statblock-sync/src/to-foundry.ts`
- Test: `test/integration/statblock-to-foundry.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
  it("sets attributes.spellcasting and spells.spellN.{value,override} from statblock.spellcasting", () => {
    const markdown = `\`\`\`statblock
name: Test Archmage
cr: 12
ac: 12
hp: 100
stats: [10, 14, 12, 20, 15, 16]
traits:
  - name: Spellcasting
    desc: "The archmage is a level 18 spellcaster. Its spellcasting ability is Intelligence (spell save DC 17, +9 to hit with spell attacks). The archmage has the following wizard spells prepared: Cantrips (at will): fire bolt, light 1st level (4 slots): detect magic, shield 2nd level (3 slots): misty step, suggestion"
\`\`\`
`;
    const statblock = parseStatblock(markdown);
    const actor = statblockToFoundryActor(statblock);
    const system = actor.system as Record<string, any>;

    expect(system.attributes.spellcasting).toBe("int");
    expect(system.spells.spell1).toEqual({ value: 4, override: 4 });
    expect(system.spells.spell2).toEqual({ value: 3, override: 3 });
    // Cantrips (level 0) have no slot bucket to set.
    expect(system.spells.spell0).toBeUndefined();
  });

  it("omits spellcasting fields entirely for a non-caster", () => {
    const statblock = parseStatblock(`\`\`\`statblock
name: Test Beast
cr: 1
ac: 12
hp: 20
stats: [14, 12, 14, 4, 10, 6]
\`\`\`
`);
    const actor = statblockToFoundryActor(statblock);
    const system = actor.system as Record<string, any>;
    expect(system.attributes.spellcasting).toBeUndefined();
    expect(system.spells).toBeUndefined();
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run test/integration/statblock-to-foundry.test.ts -t "spellcasting"`
Expected: FAIL.

- [ ] **Step 3: Implement in `to-foundry.ts`**

In `statblockToFoundryActor`, after the `resources` block is computed (Task 3), add:

```ts
  const spellSlots: Record<string, { value: number; override: number }> = {};
  if (statblock.spellcasting) {
    for (const lvl of statblock.spellcasting.levels) {
      if (lvl.level === 0 || !lvl.slots) continue; // cantrips have no slot bucket
      spellSlots[`spell${lvl.level}`] = { value: lvl.slots, override: lvl.slots };
    }
  }
```

Add to `system.attributes` (inside the existing `attributes: { ... }` object, alongside `senses`):

```ts
      ...(statblock.spellcasting ? { spellcasting: statblock.spellcasting.ability } : {}),
```

Add a conditional top-level `spells` key to `system` (alongside `resources`):

```ts
    ...(statblock.spellcasting ? { spells: spellSlots } : {}),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run test/integration/statblock-to-foundry.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add packages/statblock-sync/src/to-foundry.ts test/integration/statblock-to-foundry.test.ts
git commit -m "feat(statblock-sync): emit attributes.spellcasting and spell slot buckets"
```

---

### Task 19: `import-npc.ts` — resolve spell names + attach embedded items

**Files:**
- Modify: `packages/statblock-sync/src/import-npc.ts`

- [ ] **Step 1: Extend `ImportNpcDeps` and `importNpc`**

Replace the file's contents with the following (full file, since almost every part changes):

```ts
/**
 * The "sync layer" that actually executes a match plan against a live (or
 * mock) world: Tier 1 clones the matched compendium entry via
 * `import_from_compendium`; anything else falls back to synthesizing an
 * actor with `statblockToFoundryActor` (Tier 3) and creating it directly.
 * After the actor exists (either tier), a spellcasting statblock's spell
 * list is resolved against the official `dnd5e.spells24` compendium (falling
 * back to the 2014 `dnd5e.spells` pack) and attached as embedded Items;
 * unmatched names get a minimal placeholder item instead of failing the
 * import (see docs/statblock-legendary-lair-spellcasting-plan.md, Part B).
 *
 * Kept decoupled from the bridge's transport/relay types (injected `deps`
 * instead) so this package stays usable standalone and mock-first testable —
 * see docs/obsidian-statblock-npc-sync-plan.md §5.
 *
 * Scope note: Tier 1 here is "exact name match, clone as-is" — it does not
 * yet diff the statblock against the compendium actor and patch deltas on
 * top (the design doc's fuller Tier 1 description). That patching is later
 * work; an exact SRD-name match today still gets the official, fully
 * mechanical actor, just without statblock-specific overrides applied.
 */

import type { CompendiumEntry } from "@foundry-mcp-bridge/shared";
import type { StatblockData } from "./schema.js";
import { statblockToFoundryActor, type Dnd5eActorDocument } from "./to-foundry.js";
import { matchStatblock } from "./match.js";

export interface ImportNpcResult {
  actorId: string;
  tier: 1 | 3;
  /** The compendium entry cloned, when `tier === 1`. */
  matchedUuid?: string;
}

export interface ImportNpcDeps {
  /** Search the world's compendia for actors matching `nameQuery`. */
  searchCompendium(nameQuery: string): Promise<CompendiumEntry[]>;
  /** Clone a compendium entry into the world, applying an optional patch. */
  importFromCompendium(uuid: string, patch?: Record<string, unknown>): Promise<{ _id: string }>;
  /** Create a synthesized document from scratch (Tier 3 fallback). */
  createDocument(data: Dnd5eActorDocument): Promise<{ _id: string }>;
  /** Upload an image file and return the resolved remote path. */
  uploadImage?(filename: string, contentBase64: string, targetFolder?: string): Promise<string>;
  /** Search Item compendia (all packs) for a spell by name. */
  searchSpellCompendium(nameQuery: string): Promise<CompendiumEntry[]>;
  /** Clone a compendium Item as an embedded Item on the given actor. */
  importEmbeddedFromCompendium(parentId: string, uuid: string): Promise<{ _id: string }>;
  /** Create a literal (non-compendium) embedded Item on the given actor. */
  createEmbeddedItem(parentId: string, data: Record<string, unknown>): Promise<{ _id: string }>;
}

/**
 * Import a parsed statblock into the world, preferring a Tier 1 compendium
 * clone over Tier 3 synthesis whenever the statblock's name exactly matches
 * an existing compendium actor — the "works like the official compendium
 * monster" goal (design doc §1).
 */
export async function importNpc(
  statblock: StatblockData,
  deps: ImportNpcDeps,
  imageContent?: { filename: string; contentBase64: string }
): Promise<ImportNpcResult> {
  const index = await deps.searchCompendium(statblock.data.name);
  const plan = matchStatblock(statblock, index);

  let result: ImportNpcResult;
  if (plan.tier === 1) {
    const doc = await deps.importFromCompendium(plan.uuid, plan.patch);
    result = { actorId: doc._id, tier: 1, matchedUuid: plan.uuid };
  } else {
    // For Tier 3: upload image if provided, then use resolved path in actor data
    let resolvedImagePath: string | undefined;
    if (imageContent && deps.uploadImage) {
      resolvedImagePath = await deps.uploadImage(
        imageContent.filename,
        imageContent.contentBase64,
        `worlds/npcs/${statblock.data.name.replace(/\s+/g, "-").toLowerCase()}`
      );
    }

    const actorData = statblockToFoundryActor(statblock, resolvedImagePath);
    const doc = await deps.createDocument(actorData);
    result = { actorId: doc._id, tier: 3 };
  }

  if (statblock.spellcasting) {
    await attachSpells(statblock.spellcasting, result.actorId, deps);
  }

  return result;
}

/**
 * Resolve and attach each spell name in a parsed spellcasting block as an
 * embedded Item on the actor: exact-match (case-insensitive) against the
 * official `dnd5e.spells24` pack first, falling back to the 2014 `dnd5e.spells`
 * pack, and finally a minimal placeholder item (name only, default icon) so
 * a typo'd or homebrew spell name never fails the whole import.
 */
async function attachSpells(
  spellcasting: NonNullable<StatblockData["spellcasting"]>,
  actorId: string,
  deps: ImportNpcDeps
): Promise<void> {
  for (const level of spellcasting.levels) {
    for (const spellName of level.spellNames) {
      const results = await deps.searchSpellCompendium(spellName);
      const exactIn = (pack: string) =>
        results.find(
          (r) => r.pack === pack && r.name.toLowerCase() === spellName.toLowerCase()
        );
      const match = exactIn("dnd5e.spells24") ?? exactIn("dnd5e.spells");

      if (match) {
        await deps.importEmbeddedFromCompendium(actorId, match.uuid);
      } else {
        await deps.createEmbeddedItem(actorId, {
          name: spellName,
          type: "spell",
          img: "icons/svg/book.svg",
        });
      }
    }
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: FAIL — `test/integration/statblock-import.test.ts`'s `realDeps()` doesn't implement the three new
required `ImportNpcDeps` methods yet. Confirm the error is exactly that before moving on.

- [ ] **Step 3: Update `realDeps()` in `statblock-import.test.ts`**

Add to the object `realDeps()` returns:

```ts
    async searchSpellCompendium(nameQuery) {
      return unwrap<CompendiumEntry[]>(
        await runSearchCompendium(transport, { documentType: "Item", nameQuery }),
        "searchSpellCompendium",
      );
    },
    async importEmbeddedFromCompendium(parentId, uuid) {
      const created = unwrap<Array<{ _id: string }>>(
        await runImportEmbeddedFromCompendium(transport, {
          parentType: "Actor",
          parentId,
          embeddedName: "Item",
          uuids: [{ uuid }],
        }),
        "importEmbeddedFromCompendium",
      );
      return created[0]!;
    },
    async createEmbeddedItem(parentId, data) {
      const created = unwrap<Array<{ _id: string }>>(
        await runCreateEmbedded(transport, {
          parentType: "Actor",
          parentId,
          embeddedName: "Item",
          data: [data],
        }),
        "createEmbeddedItem",
      );
      return created[0]!;
    },
```

Add `runImportEmbeddedFromCompendium` and `runCreateEmbedded` to the file's import block from
`../../packages/mcp-server/src/tools.js`.

- [ ] **Step 4: Typecheck again**

Run: `npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/statblock-sync/src/import-npc.ts test/integration/statblock-import.test.ts
git commit -m "feat(statblock-sync): resolve and attach spells during NPC import"
```

---

### Task 20: `verify-npc.ts` — spellcasting checks

**Files:**
- Modify: `packages/statblock-sync/src/verify-npc.ts`

- [ ] **Step 1: Extend `FoundryActorReadBack`'s item shape**

Change:

```ts
  items?: Array<{ name: string; type: string; system?: Record<string, unknown> }>;
```

to:

```ts
  items?: Array<{
    name: string;
    type: string;
    img?: string;
    system?: Record<string, unknown>;
    _stats?: Record<string, unknown>;
  }>;
```

- [ ] **Step 2: Add the checks**

Import `getAbilityModifier`/`getProficiencyBonus` are already imported. Add, right after the existing
recharge check inside the `for (const action of statblock.actions)` loop closes (i.e. after the actions
loop, before the "Skill proficiencies" section):

```ts
  // Spellcasting: ability/DC/attack-bonus are always *derived* by dnd5e from
  // attributes.spellcasting + proficiency bonus (there is no stored DC/bonus
  // field) — so these checks assert the derivation, not a stored value.
  if (statblock.spellcasting) {
    const sc = statblock.spellcasting;
    const gotAbility = system.attributes?.spellcasting;
    checks.push({
      name: "Spellcasting ability",
      pass: gotAbility === sc.ability,
      got: gotAbility,
      want: sc.ability,
    });

    const prof = getProficiencyBonus(statblock.challenge.cr);
    const abilityScore = (statblock.abilities_ as Record<string, number>)[sc.ability];
    const abilityMod = abilityScore !== undefined ? getAbilityModifier(abilityScore) : 0;
    const expectedDc = 8 + prof + abilityMod;
    checks.push({
      name: "Spellcasting DC (derived from ability + proficiency)",
      pass: expectedDc === sc.dc,
      got: expectedDc,
      want: sc.dc,
    });
    const expectedAttackBonus = prof + abilityMod;
    checks.push({
      name: "Spellcasting attack bonus (derived from ability + proficiency)",
      pass: expectedAttackBonus === sc.attackBonus,
      got: expectedAttackBonus,
      want: sc.attackBonus,
    });

    const spellsRB = system.spells as Record<string, any> | undefined;
    for (const lvl of sc.levels) {
      if (lvl.level === 0 || !lvl.slots) continue;
      const got = spellsRB?.[`spell${lvl.level}`]?.value;
      checks.push({
        name: `Spell slots level ${lvl.level} (spells.spell${lvl.level}.value)`,
        pass: got === lvl.slots,
        got,
        want: lvl.slots,
      });
    }

    for (const lvl of sc.levels) {
      for (const spellName of lvl.spellNames) {
        const item = readBack.items?.find((i) => i.name.toLowerCase() === spellName.toLowerCase());
        if (!item) {
          checks.push({
            name: `Spell "${spellName}" attached`,
            pass: false,
            got: undefined,
            want: "item",
          });
          continue;
        }
        // Proves it's the official compendium item (mechanics + icon came
        // free), not a synthesized placeholder — a placeholder has no
        // _stats.compendiumSource, so this fails exactly for the cases the
        // plan wants surfaced as an explicit check, not a silent gap.
        const compendiumSource = item._stats?.compendiumSource;
        const fromOfficialPack =
          typeof compendiumSource === "string" && compendiumSource.includes("spells24");
        checks.push({
          name: `Spell "${spellName}" is the official dnd5e.spells24 item`,
          pass: fromOfficialPack,
          got: compendiumSource,
          want: "dnd5e.spells24",
        });
      }
    }
  }
```

- [ ] **Step 3: Write tests**

Add a new `describe` block to `test/integration/statblock-verify.test.ts` mirroring the legendary/lair
tests added in Task 4: build a statblock with a Spellcasting trait, build a fake read-back manually (not
via `statblockToFoundryActor`, since items need `_stats.compendiumSource` which the converter never sets —
construct the `FoundryActorReadBack` object literal directly with `system.attributes.spellcasting`,
`system.spells`, and an `items` array containing one item with `_stats: { compendiumSource: "Compendium.dnd5e.spells24.xyz" }`
and one item with no `_stats` at all (the placeholder case)), and assert:
- The ability/DC/attack-bonus/slot checks pass when the read-back matches an internally-consistent
  statblock (CR/ability score chosen so `8 + prof + mod === dc`).
- The "is the official dnd5e.spells24 item" check passes for the item with `_stats.compendiumSource` set
  and fails for the one without.
- The "attached" check fails when a spell name has no matching item at all.

- [ ] **Step 4: Run tests**

Run: `npx vitest run test/integration/statblock-verify.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add packages/statblock-sync/src/verify-npc.ts test/integration/statblock-verify.test.ts
git commit -m "feat(statblock-sync): verify spellcasting fields and spell attachment on read-back"
```

---

### Task 21: Wizard acceptance fixture + full mock end-to-end (including a misspelled spell)

**Files:**
- Create: `test/fixtures/statblock-import/test-archmage.md`
- Modify: `test/integration/statblock-import.test.ts`

- [ ] **Step 1: Write the fixture**

Ability scores are chosen so the derived DC/attack bonus match the printed values exactly (Task 20's check
requires this): CR 12 → proficiency +4; Intelligence 20 → mod +5; `8 + 4 + 5 = 17` (DC), `4 + 5 = 9`
(attack) — matching the plan's own "spell save DC 17, +9 to hit" text.

```markdown
# Test Archmage

```statblock
name: Test Archmage
size: Medium
type: humanoid
alignment: Any Alignment
ac: 12
ac_class: 15 with mage armor
hp: 100
hit_dice: 16d8+32
speed: 30 ft.
stats: [10, 14, 12, 20, 15, 16]
saves:
  - intelligence: 9
  - wisdom: 8
skillsaves:
  - arcana: 13
  - history: 13
senses: passive Perception 12
languages: Common plus five other languages
cr: 12
traits:
  - name: Spellcasting
    desc: "The archmage is a level 18 spellcaster. Its spellcasting ability is Intelligence (spell save DC 17, +9 to hit with spell attacks). The archmage has the following wizard spells prepared: Cantrips (at will): fire bolt, light, mage hand, prestidigitation 1st level (4 slots): detect magic, mage armor, magic missile, shield 2nd level (3 slots): misty step, suggestion 3rd level (3 slots): counterspell, fireball, fli 4th level (3 slots): dimension door, greater invisibility 5th level (1 slot): cone of cold"
actions:
  - name: Dagger
    desc: "Melee or Ranged Attack Roll: +6, reach 5 ft. or range 20/60 ft. Hit: 4 (1d4 + 2) Piercing damage."
```

A robed spellcaster of formidable renown, kept deliberately generic — a stand-in for any archmage-shaped
NPC a table might need on short notice.
```

Note the deliberate typo: `fli` instead of `fly` in the 3rd-level list — this is the plan's required
"deliberately-misspelled spell" case for exercising the placeholder-fallback path end-to-end.

- [ ] **Step 2: Lint it**

Run: `npm run lint:statblock -- test/fixtures/statblock-import/test-archmage.md`
Expected: `LINT PASSED`. (The Spellcasting trait's free-form prose isn't covered by the 2024 attack/save
grammar checks — per correction #7-adjacent finding in the research, the lint has no awareness of
spellcasting text at all, so this should pass purely on the `Dagger` action's 2024-form attack header.) If
the lint rejects the Dagger action's "Melee or Ranged Attack Roll" combined-form header, split it into
whichever single header form the lint's grammar accepts (check the lint failure message) — don't fight the
lint; simplify the fixture's action instead, since the action mechanics aren't the point of this fixture.

- [ ] **Step 3: Write the mock end-to-end test**

Add to `test/integration/statblock-import.test.ts`, seeding spell compendium fixtures directly on
`mock.compendium` before running `importNpc` (per correction #7: the shared SRD loader can't represent a
`dnd5e.spells24` pack today, so seed it locally in this test):

```ts
describe("importNpc: spellcasting", () => {
  function seedSpells(mock: MockFoundry) {
    const spells24: Array<[string, string]> = [
      ["fire-bolt", "Fire Bolt"],
      ["light", "Light"],
      ["mage-hand", "Mage Hand"],
      ["prestidigitation", "Prestidigitation"],
      ["detect-magic", "Detect Magic"],
      ["mage-armor", "Mage Armor"],
      ["magic-missile", "Magic Missile"],
      ["shield", "Shield"],
      ["misty-step", "Misty Step"],
      ["suggestion", "Suggestion"],
      ["counterspell", "Counterspell"],
      ["fireball", "Fireball"],
      // deliberately no "Fly" entry — exercises the placeholder-fallback path
      ["dimension-door", "Dimension Door"],
      ["greater-invisibility", "Greater Invisibility"],
      ["cone-of-cold", "Cone of Cold"],
    ];
    for (const [slug, name] of spells24) {
      mock.compendium.set(`Compendium.dnd5e.spells24.${slug}`, {
        documentType: "Item",
        pack: "dnd5e.spells24",
        data: { name, type: "spell", system: { level: 0 } },
      });
    }
  }

  it("imports a spellcasting NPC, attaching real spells and a placeholder for the misspelled one", async () => {
    const mock = new MockFoundry();
    seedSpells(mock);
    const transport = new MockTransport(mock);
    const statblock = loadStatblock("test-archmage.md");

    const result = await importNpc(statblock, realDeps(transport));

    expect(result.tier).toBe(3);
    const actors = mock.documents("Actor") as Array<{
      _id: string;
      name: string;
      system: Record<string, any>;
      items: Array<{ name: string; type: string; _stats?: Record<string, any> }>;
    }>;
    const created = actors.find((a) => a._id === result.actorId)!;

    expect(created.system.attributes.spellcasting).toBe("int");
    expect(created.system.spells.spell1).toEqual({ value: 4, override: 4 });
    expect(created.system.spells.spell5).toEqual({ value: 1, override: 1 });

    const fireball = created.items.find((i) => i.name === "Fireball")!;
    expect(fireball._stats?.compendiumSource).toBe("Compendium.dnd5e.spells24.fireball");

    // "fli" (the misspelled "fly") has no compendium match -> placeholder item.
    const placeholder = created.items.find((i) => i.name === "fli")!;
    expect(placeholder).toBeDefined();
    expect(placeholder._stats?.compendiumSource).toBeUndefined();

    const report = verifyImportedNpc(
      { _id: created._id, name: created.name, type: "npc", system: created.system, items: created.items },
      statblock,
    );
    // The misspelled spell's failed check must surface explicitly, not pass silently.
    expect(report.ok).toBe(false);
    expect(report.checks.some((c) => c.name.includes('"fli"') && !c.pass)).toBe(true);
    // Everything else about spellcasting should still check out.
    expect(report.checks.find((c) => c.name === "Spellcasting ability")?.pass).toBe(true);
    expect(report.checks.find((c) => c.name.includes("DC"))?.pass).toBe(true);
  });
});
```

Add `verifyImportedNpc` to this test file's existing `@foundry-mcp-bridge/statblock-sync` import (it
currently only imports `parseStatblock`, `importNpc`, `type ImportNpcDeps`).

Note: the mock's `create` command mints `_stats.compendiumSource` only if the runtime/mock sets it — check
whether `mock-foundry.ts`'s `importEmbeddedFromCompendium` (Task 11) actually stamps `_stats.compendiumSource`
on the cloned data. **It doesn't yet** (Task 11's implementation just spreads `record.data`). Foundry's real
`createEmbeddedDocuments` stamps `_stats.compendiumSource` automatically from the source UUID; the mock
must replicate this or the test above (and the real `verify-npc.ts` check) can't be exercised against the
mock. Add one line to Task 11's `importEmbeddedFromCompendium` mock method before pushing:

```ts
      const data = entry.patch ? applyUpdate(record.data, entry.patch) : structuredClone(record.data);
      data._stats = { ...(data._stats as Record<string, unknown> | undefined), compendiumSource: entry.uuid };
      created.push({ ...data, _id: randomID() });
```

(Go back and add this line to Task 11's mock method now if it's already committed — a small follow-up
commit is fine.)

- [ ] **Step 4: Run test to verify it fails, then passes**

Run: `npx vitest run test/integration/statblock-import.test.ts -t "spellcasting"`
Expected: FAIL first (missing `_stats.compendiumSource` stamping), then PASS after the Task 11 follow-up
edit above.

- [ ] **Step 5: Full verification gate**

Run: `npm run typecheck && npm test`
Expected: PASS, no regressions anywhere in the repo.

- [ ] **Step 6: Commit**

```bash
git add test/fixtures/statblock-import/test-archmage.md test/integration/statblock-import.test.ts \
  test/integration/mock-foundry.ts
git commit -m "test(statblock-sync): end-to-end spellcasting import with placeholder fallback"
```

---

### Task 22 (Part B live pass): live-Foundry verification

**Files:** none (manual/live verification, using `mcp__foundry__*` tools).

- [ ] **Step 1:** Run `npm run selftest` first to confirm the real relay → module → mock-Foundry path
  (not the in-process mock) still works end-to-end after all these changes.

- [ ] **Step 2:** Import the Test Archmage fixture into the live/Forge world (via the same `importNpc`
  flow, or by hand-driving `mcp__foundry__search_compendium` / `mcp__foundry__import_embedded_from_compendium`
  / `mcp__foundry__create_document` in sequence) and confirm on the actual sheet:
  - Cast Fireball from the sheet: the chat card shows the SRD damage/save text and the fireball icon (not
    a generic book icon).
  - The Spells tab shows the correct slot counts per level (4/3/3/3/1).
  - The deliberately-misspelled "fli" item shows as a placeholder (default icon, no mechanics), not a
    crash or missing item.

- [ ] **Step 3:** If `system.spells.spellN`'s real shape, or the spell item's `_stats.compendiumSource`
  path, differs from what Task 17 found (e.g. a Foundry/dnd5e version difference from what was extracted),
  stop and correct Tasks 18/20 rather than declaring success — this live pass is the actual acceptance bar
  the source plan sets, not the mock tests alone.

- [ ] **Step 4:** Report the full pass/fail status of both Part A's and Part B's live checks.

---

## Final verification gate (both parts)

- [ ] Run `npm run typecheck` — PASS.
- [ ] Run `npm test` — PASS, no regressions.
- [ ] Run `npm run selftest` — PASS (real relay/module/mock-Foundry path).
- [ ] Run `npm run lint:statblock -- test/fixtures/statblock-import/young-ash-wyrm.md` and
  `npm run lint:statblock -- test/fixtures/statblock-import/test-archmage.md` — both `LINT PASSED`.
- [ ] Part A and Part B live-pass checklists (Tasks 7 and 22) both reported.
