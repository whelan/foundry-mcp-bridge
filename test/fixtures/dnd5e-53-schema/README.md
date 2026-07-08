# dnd5e 5.3.3 schema ground truth

Real documents extracted verbatim from the **installed dnd5e system 5.3.3**
(Foundry core 14.364) on 2026-07-06, by reading the system's LevelDB
compendium packs directly (`.../FoundryVTT/Data/systems/dnd5e/packs/`, read
with the `classic-level` npm package — the raw `.ldb` files are
Snappy-compressed, so `strings`/grep on them is useless).

These exist because a cloud/CI session has **no Foundry install and no live
world**: when reworking `packages/statblock-sync/src/to-foundry.ts` for the
modern Activities schema, these files are the only trustworthy reference for
what dnd5e 5.3.3 actually accepts. Do not "improve" them to match code —
code must match them.

Content is SRD 5.1/5.2 material from the dnd5e system, licensed CC-BY-4.0
(the `system.source.license` field inside the documents carries the
attribution). Used here as schema test fixtures only.

## Files and what each demonstrates

- **`ghast-full.json`** — a complete 2024 NPC actor (assembled: the
  `!actors!` doc plus its `!actors.items!` embedded items). The closest
  official analog to the Gravemire Stalker acceptance NPC: Medium undead,
  darkvision (`system.attributes.senses.ranges.darkvision: 60`), necrotic
  resistance (`system.traits.dr.value`), charmed/poisoned/exhaustion
  condition immunities (`system.traits.ci.value`), languages with
  `.communication`, a **Stench** trait (`feat` item, `system.type.value:
  "monster"`, `properties: ["trait"]`, with a passive save activity), and a
  **Claw** natural weapon (`system.type.value: "natural"`, structured
  `system.damage.base` with `number`/`denomination`/`types`, an `attack`
  activity with `flat: false` for auto-calculated to-hit).

- **`white-dragon-wyrmling-full.json`** — complete NPC actor demonstrating
  the exact shapes Grave Breath needs: **Cold Breath** is a `feat` (NOT a
  weapon) with a `save` activity (CON save, 15-ft cone via
  `target.template {type: "cone", size: "15"}`, `damage.parts` +
  `onSave: "half"`) and **Recharge 5–6** as item-level
  `uses: {max: "1", spent: 0, recovery: [{period: "recharge", formula: "5",
  type: "recoverAll"}]}` plus a `consumption.targets` entry of type
  `itemUses`. Also **Multiattack** (`feat` + `utility` activity) and
  **Rend** (another attack weapon).

- **`rotting-touch-weapon.json`** — (from `monsterfeatures24`) the
  **flat attack bonus** pattern: `activities.<id>.attack = {flat: true,
  ability: "none", bonus: "2", type: {value: "melee", classification: ""}}`.
  This is the pattern to emit for homebrew statblocks, where the stated
  to-hit must be reproduced exactly rather than derived.

- **`abduct-feat.json`** — (from `monsterfeatures24`) minimal passive
  trait: `feat` item, `system.type.value: "monster"`, `properties:
  ["trait"]`, `activities: {}`. The template for purely descriptive
  traits/actions.

- **`wight-actor-only.json`** — NPC actor (no items) proving the **skill
  proficiency format**: `system.skills.prc = { ability: "wis", value: 1,
  bonuses: { check: "", passive: "" }, roll: {...} }` — `value` is the
  proficiency *multiplier*, never the printed total bonus.

## Key schema facts these files prove (vs. the legacy shapes the repo used)

| Concern | Legacy (what `to-foundry.ts` emitted pre-rewrite) | dnd5e 5.3.3 reality (see fixtures) |
|---|---|---|
| Item type for traits/features | `"feature"` | `"feat"` (`"feature"` is not a dnd5e item type at all) |
| Attack roll | `system.attack.bonus: "+5"` on item | `attack` activity in `system.activities`; flat bonus via `{flat: true, ability: "none", bonus: "5"}` |
| Weapon damage | `system.damage.parts: [["1d10+3","slashing"]]` | `system.damage.base: {number, denomination, bonus, types, custom, scaling}`; extra parts on the activity's `damage.parts` (same structured shape), `includeBase: true` |
| Save action | weapon w/ `system.save: {ability, dc: {value, scaling}}` | `feat` w/ `save` activity: `save: {ability: ["con"], dc: {calculation: "", formula: "12"}}` (empty calculation = flat formula) |
| Recharge | `system.recharge: {value, charged}` | item `uses.recovery: [{period: "recharge", formula: "5", type: "recoverAll"}]`, `uses.max: "1"` |
| Senses | `system.traits.senses` (string) | `system.attributes.senses.ranges.{darkvision,...}` (numbers) + `.special` |
| Damage resist/immune/vuln, cond. immune | `system.traits_.damageResistances.value` etc. | `system.traits.{dr,di,dv,ci}.value` |
| Skill proficiency | `system.skills.ste.value: 4` (total bonus) | `value: 1` (proficiency **multiplier**; total is derived). Flat adjustments go in `bonuses.check` |
| Save proficiency | (unmodeled) | `system.abilities.<abl>.proficient: 1` |
| Languages | `{value: [...strings]}` | `{value: [...known keys], custom: "free text", communication: {}}` |
| `details.race` | `{value: ""}` | a `LocalDocumentField` (Item reference), officially `null` on NPCs (see ghast). Emitting `{value: ""}` is precisely what dry-run rejected with `"The value provided to a LocalDocumentField must be a BaseItem instance."` — omit it entirely |
| `details.xp` | `xp: 700` (number) | not an NPC field at all (derived from CR) — omit |
| Movement | always emits `walk/fly/swim/burrow/climb` with 0s | officials only carry the speeds the creature has (ghast: walk only; wyrmling: walk/fly/swim/burrow) — omit absent speeds |

Note when comparing: the compendium documents strip schema-default keys, so
two officials can show different key sets for the same field (Ghast's Claw
attack activity has no `attack.bonus` key at all; Rotting Touch's does).
Structural comparisons should union multiple officials rather than treating
any single document as the complete shape.
