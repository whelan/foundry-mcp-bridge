# Plan: legendary actions, lair actions, and spellcasting

Extends `docs/statblock-import-execution-plan.md` (M0–M7, now accepted) with
the three features the acceptance NPC (Gravemire Stalker) deliberately
didn't exercise: legendary actions, lair actions, and spellcasting. Same
milestone-and-fixture discipline as before: schema → grammar/math →
`to-foundry.ts` → mock verification → live M6-style pass.

This is **two independent tracks**, sized very differently:

- **Part A — legendary + lair actions.** Small. The action-conversion
  pipeline already handles these types; this closes real gaps in the
  *resource fields* dnd5e needs to make them functional on the sheet, plus a
  fixture that finally exercises the `"legendary"`/`"lair"` code path at all.
- **Part B — spellcasting.** New feature. Nothing in `statblock-sync` parses
  or emits spells today. It also needs one new wire-protocol capability (see
  below), so it goes through the `add-foundry-command` skill, not just a
  `statblock-sync` change.

Do Part A first — it's a day, touches no protocol code, and gets a second
legendary-creature fixture into the M6 live-verification rotation. Part B is
its own project.

---

## Part A — legendary actions + lair actions

### What already works

`grammar.ts`/`schema.ts` already parse the statblock's `legendary_actions`
and `lair_actions` YAML lists into the same `actions: StatblockData["actions"]`
array as `actions`/`reactions`, tagged `type: "legendary"` / `type: "lair"`
(`packages/statblock-sync/src/parse.ts:298-301`). `to-foundry.ts`'s
`actionToItem` already treats those type strings as valid dnd5e activation
types (`packages/statblock-sync/src/to-foundry.ts:288-291`) and emits
correctly-shaped `feat`/`weapon` items with `activation.type: "legendary"` or
`"lair"`. **The item-level round-trip already works** — it's just never been
exercised against live Foundry because Gravemire Stalker has neither.

### What's missing

Confirmed live (read back `6xQGvucabEegbAAU` mid-session): dnd5e tracks
legendary-action and legendary-resistance uses as ACTOR-level *resources*,
separate from the action items themselves:

```json
"resources": {
  "legact": { "max": 0, "spent": 0 },
  "legres": { "max": 0, "spent": 0 },
  "lair": { "value": false, "initiative": null, "inside": false }
}
```

Nothing in `to-foundry.ts` sets these. A statblock with three legendary
action entries would still show `legact.max: 0` — no legendary-action tracker
would render on the sheet at all, even though the action items themselves
are correctly formed. Similarly, "Legendary Resistance (3/Day)" is presently
just a `traits` entry (a plain `feat` with unlimited "uses" — no `(3/Day)`
extraction), and lair-action initiative (`resources.lair.initiative`,
conventionally 20) is never set.

### Schema/parse additions (`schema.ts`, `parse.ts`)

- `legendary_action_count?: number` — explicit override; when absent, derive
  from `legendary_actions.length` (most statblocks don't spend one action's
  worth on a free action, so count-of-entries is the correct default for the
  acceptance case, but let authors override for creatures with a "free"
  legendary action or multiattack-costing-two conventions later).
- Legendary Resistance uses: parse `(N/Day)` out of a trait named exactly
  `/^Legendary Resistance/i` (case-insensitive), same regex-against-known-
  phrasing style `grammar.ts` already uses for attack/save text — not a new
  parsing paradigm.
- `lair_actions.length > 0` alone is enough to set `resources.lair.initiative
  = 20` (2024 SRD default); no new field needed unless a fixture later needs
  a non-20 lair initiative.

### `to-foundry.ts` additions

- `system.resources.legact.max` = the derived/explicit legendary action
  count.
- `system.resources.legres.max` = parsed `(N/Day)`, and the Legendary
  Resistance trait's `feat` item gets real `uses: { max: "N", recovery:
  [{ period: "day", type: "recoverAll" }] }` instead of unlimited — this is
  the same `uses`/`recovery` shape `featItem` already knows how to emit for
  Grave Breath's recharge (`activities.ts`), just a different recovery
  period.
- `system.resources.lair.initiative` = `20` when `lair_actions` is non-empty.

### Verification (`verify-npc.ts`)

Add checks mirroring the existing recharge/proficiency checks already there:
`legact.max` matches the legendary-action count, `legres.max` matches the
parsed `(N/Day)`, `lair.initiative === 20` when lair actions are present.

### Acceptance NPC for this track

A young dragon shape is the natural choice — legendary actions, legendary
resistance, and a lair action together, still small enough to hand-author:

```yaml
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

("Costs 2 Actions" in a legendary-action name/desc is a parse-and-ignore
case for now — it doesn't need mechanical enforcement in Foundry, dnd5e's
sheet just tracks total legendary-action budget, not a per-action cost.
Note it in `verify-npc.ts` as a known limitation, not a blocker.)

### Milestones (Part A)

1. **Schema + parse**: `legendary_action_count`, Legendary Resistance
   `(N/Day)` regex, unit tests in the existing `parse.test.ts`/`grammar.
   test.ts` style.
2. **`to-foundry.ts`**: emit `resources.legact/legres/lair`, tests in
   `test/integration/statblock-to-foundry.test.ts`.
3. **`verify-npc.ts`**: new checks + tests.
4. **Fixture + mock end-to-end**: `test/fixtures/statblock-import/young-ash-
   wyrm.md`, driven through `verifyImportedNpc` against `mock-foundry`,
   same shape as the existing Gravemire Stalker mock test.
5. **Live M6a/M6b pass**: `npm run selftest:live` extended to run both NPC
   legs (Gravemire Stalker + Young Ash Wyrm) back to back; manual checklist
   adds "legendary action tracker shows 3, clicking one spends it",
   "Legendary Resistance shows 3/3 uses", "lair action fires at initiative
   20".

---

## Part B — spellcasting

### Why compendium-match, not text-parsed mechanics

A statblock's "Spellcasting" trait only ever lists spell *names* —
"the wizard has the following spells prepared: fire bolt, mage armor,
fireball..." — never their mechanics (range, components, damage, save
type). Grammar-parsing full spell mechanics out of prose would mean
re-implementing hundreds of SRD spells by hand and would never produce a
correct spell *icon* (there's no icon information in the text at all).

The existing "Tiers 1–2" quality upgrade already scoped in the execution
plan (`docs/statblock-import-execution-plan.md`, "After acceptance")
described exactly the right tool for this: `searchCompendium` +
`importFromCompendium` matching named content to official compendium data.
Confirmed live — the `dnd5e.spells24` pack has the full 2024 SRD spell list
with correct mechanics and icons out of the box:

```
searchCompendium({ documentType: "Item", nameQuery: "Fireball" })
→ { uuid: "Compendium.dnd5e.spells24.Item.phbsplFireball00", pack: "dnd5e.spells24", name: "Fireball", type: "spell" }
```

So: parse the spell *list* (names, levels, slot counts) from the
statblock's Spellcasting trait text; resolve each name against
`dnd5e.spells24`; attach the official item. Mechanics and icon come free,
correctly, every time a name matches — the only new work is the list
parser and getting matched items onto the actor.

### The missing protocol piece

`importFromCompendium` (`packages/mcp-server/src/reliability.ts:844`)
creates a **world-level** document only — `fromUuid` → `cls.create()`, no
parent. There's no existing way to clone a compendium document directly as
an **embedded** document on an actor (`Actor#createEmbeddedDocuments`);
`create_embedded`'s `data` is literal JSON supplied by the caller, and
nothing exposes "fetch a compendium document's full data" without also
creating a world copy of it.

This needs a new command — call it `import_embedded_from_compendium` —
mirroring `import_from_compendium`'s shape (`fromUuid` → optional `patch` →
create) but targeting `parentType`/`parentId`/`embeddedName` instead of a
top-level collection, the same way `create_embedded` differs from `create`.
Follow the `add-foundry-command` skill's lockstep for this: zod schema in
`packages/shared/src/protocol.ts` first, then `protocol-executor.ts`
dispatch, the `FoundryDocumentApi` interface, `foundry-runtime.ts` (real:
`fromUuid` + `parent.createEmbeddedDocuments`), `mock-foundry.ts` +
`mock-foundry-api.ts`, and the reliability-pipeline wrapper in
`mcp-server` (dry-run → write → read-back **parent** → rollback, same
contract `createEmbedded` already uses per `docs/command-lifecycle.md`).

Accept an array (`uuids: Array<{ uuid: string; patch?: object }>`) so a
whole spell list attaches in one call instead of one round-trip per spell.

### Schema additions (`schema.ts`)

A `spellcasting` block on the statblock, parsed from the "Spellcasting"
(or "Innate Spellcasting") trait's raw text rather than added as new
authored YAML fields — the acceptance NPC below writes it exactly like a
2024 Monster Manual statblock would, no new note-authoring convention to
learn:

```yaml
traits:
  - name: Spellcasting
    desc: "The archmage is a level 18 spellcaster. Its spellcasting ability
      is Intelligence (spell save DC 17, +9 to hit with spell attacks). The
      archmage has the following wizard spells prepared:
      Cantrips (at will): fire bolt, light, mage hand, prestidigitation
      1st level (4 slots): detect magic, mage armor, magic missile, shield
      2nd level (3 slots): misty step, suggestion
      3rd level (3 slots): counterspell, fireball, fly
      4th level (3 slots): dimension door, greater invisibility
      5th level (1 slot): cone of cold"
```

Parsed shape (`StatblockData.spellcasting?`):

```ts
{
  ability: "int" | "wis" | "cha";
  dc: number;
  attackBonus: number;
  levels: Array<{
    level: 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9; // 0 = cantrips
    slots?: number; // absent for cantrips (at will)
    spellNames: string[];
  }>;
}
```

### Grammar (`grammar.ts`)

New `parseSpellcastingTrait(desc: string)`: same targeted-regex style as
`parseAttackAction`/`parseSaveAction` (this is standardized 5e statblock
phrasing, not free text) —

- `spell save DC (\d+)`, `\+(\d+) to hit with spell attacks` for DC/attack
  bonus.
- `spellcasting ability is (\w+)` mapped through the same ability-name
  table `getSkillAbility`/`math.ts` already use.
- Per-level lines: `/^(Cantrips \(at will\)|(\d)(?:st|nd|rd|th) level(?: \((\d+)
  slots?\))?): (.+)$/gm` over the trait body, splitting each spell list on
  `, `.
- Innate spellcasting variant ("1/day each: ...", "3/day each: ...") is a
  **separate acceptance case, out of scope for the first pass** — note it
  explicitly as deferred so it isn't silently half-handled.

### `to-foundry.ts` / `import-npc.ts` additions

`statblockToFoundryActor` sets, when `statblock.spellcasting` is present:

- `system.attributes.spellcasting` = the mapped ability key.
- `system.attributes.spell.dc` — wait, verify against the live schema
  (`system.attributes.spell.level`/DC fields already appeared in the
  Gravemire Stalker read-back as placeholders — confirm exact dnd5e 5.3.3
  field name before landing, same "extract a fixture, don't guess" rule the
  original execution plan used for `race`/`xp`).
- `system.spells.spellN.value`/`.max` = each level's slot count (`spell1`…
  `spell9`; cantrips don't consume a slot bucket).

`importNpc` (`import-npc.ts`) gains a step after actor creation: for each
parsed spell name, `searchCompendium({ documentType: "Item", packScope:
"dnd5e", nameQuery: spellName })`, exact-match (case-insensitive) against
`dnd5e.spells24` first, falling back to `dnd5e.spells` (2014 pack) only if
no 2024 match exists — then `import_embedded_from_compendium` onto the new
actor. **Unmatched spell names** (typo, homebrew) don't fail the import:
synthesize a minimal placeholder `spell`-type item (name only, default
icon, no mechanics) — the same Tier-3-fallback philosophy the whole-NPC
match already uses — and record it as a failed `verifyImportedNpc` check so
it surfaces exactly like today's mismatch reports, not a silent gap.

### Verification (`verify-npc.ts`)

- `spellcasting.dc`/`attackBonus` match the actor's derived save/attack
  values.
- Every parsed spell name has a corresponding embedded Item whose
  `_stats.compendiumSource` points at `dnd5e.spells24` (proves it's the
  official item, not a placeholder) — and its `img` is not the default
  mystery-man/book icon, which is the actual "did the icon come through"
  check.
- `system.spells.spellN.max` matches the parsed slot count per level.
- Unmatched-name placeholders show up as explicit failed checks (see above)
  rather than passing silently.

### Acceptance NPC for this track

An SRD-legal 2024 wizard NPC, spellcasting trait exactly as shown above
(reuse the "archmage"-shaped block), full statblock built the same way
Gravemire Stalker was — small AC/HP/save set plus the Spellcasting trait
and one or two spell-attack actions for flavor. Draft this fully before
milestone 1 starts, same as the original plan's "acceptance NPC" section —
it's the fixture every milestone below tests against.

### Milestones (Part B)

0. **Acceptance NPC** — write and lint the wizard statblock
   (`npm run lint:statblock`) before anything else.
1. **New protocol command** (`add-foundry-command` skill, full lockstep):
   `import_embedded_from_compendium` — schema, executor, real runtime,
   mock, reliability pipeline, tests at every layer per
   `docs/command-lifecycle.md`.
2. **Schema**: `StatblockData.spellcasting` shape + parser unit tests.
3. **Grammar**: `parseSpellcastingTrait` + fixture-driven unit tests
   (feed it real 2024 Monster Manual spellcasting-trait text, not just the
   acceptance NPC's).
4. **`to-foundry.ts`**: actor-level spellcasting fields + slot buckets,
   confirmed against a real extracted fixture (same "extract from a live
   Foundry install, don't guess the schema" rule as
   `test/fixtures/dnd5e-53-schema/`) — pull a real spellcaster statblock's
   actor JSON (e.g. import an official Archmage from `dnd5e.actors24` once
   locally) to confirm exact field names before landing.
5. **`import-npc.ts`**: spell-name resolution + embedded attachment +
   placeholder fallback for unmatched names.
6. **`verify-npc.ts`**: spell checks.
7. **Fixture + mock end-to-end**: full statblock → mock-Foundry round trip,
   including one deliberately-misspelled spell name to exercise the
   placeholder/failed-check path.
8. **Live M6a/M6b pass**: `selftest:live` gains the wizard leg; manual
   checklist adds "cast Fireball from the sheet, chat card shows the SRD
   damage/save text and the fireball icon (not a book icon)", "spell slots
   tab shows the right counts per level", "the deliberately-misspelled
   spell shows a placeholder item, not a crash".

---

## Sequencing

Part A → Part B, strictly. Part A is a single-package change with no new
protocol surface and directly extends work already proven live today. Part
B needs Part A's fixture-and-verification muscle memory *and* a new
protocol command — don't start it until Part A's M6a/M6b are green, for the
same reason the original plan enforced automated-gate-before-manual-check
ordering: each stage should be provably solid before the next stage builds
on it.

## Non-goals (this plan)

- Innate spellcasting ("1/day each: ...") — different trait phrasing,
  different actor fields (no prepared-spell slots), separate follow-up.
- Multiclass NPC casters — not a thing 2024 SRD statblocks express; no
  scope here.
- Homebrew (non-SRD) spell mechanics — the placeholder-item fallback is the
  permanent behavior for these, not a stopgap; hand-authoring full spell
  mechanics from prose is explicitly out of scope (see "why compendium-
  match" above).
- Legendary action "costs 2 actions" budget enforcement — tracked as a
  known limitation in Part A, not solved there.
