# dnd5e 6.0.5 schema ground truth

Real SRD documents from the **installed dnd5e system 6.0.5** (Foundry core 14.368), read on
2026-10-15 from the running Foundry with `(await fromUuid(uuid)).toObject()`: the document as the
6.0.5 data model holds it after loading. The compendium packs still store these documents at an
older system version (`_stats.systemVersion` says 5.3.0 / 4.2.0); `toObject()` applies the system's
own migration, which is exactly the shape a fresh write has to match to read back. Unlike the raw
pack records, `toObject()` also carries the schema defaults, so one document shows the full legal shape.

| File | uuid | Shows |
|---|---|---|
| `ghast-full.json` | `Compendium.dnd5e.actors24.Actor.mmGhast000000000` | a complete 2024 NPC: Stench trait, Claw attack, `senses.ranges`, `speeds` |
| `white-dragon-wyrmling-full.json` | `Compendium.dnd5e.actors24.Actor.mmWhiteDragonWyr` | natural armor (`ac.calcs: ["natural"]`, `flat: 16`), four speeds, a breath `save` activity with a recharge, Multiattack |
| `wight-actor-only.json` | `Compendium.dnd5e.actors24.Actor.mmWight000000000` | the actor without its items (the skill proficiency format) |
| `rotting-touch-weapon.json` | `Compendium.dnd5e.monsterfeatures24.Item.mmRottingTouch00` | the flat attack bonus pattern `{flat: true, ability: "none", bonus: "2"}` |
| `abduct-feat.json` | `Compendium.dnd5e.monsterfeatures24.Item.mmAbduct00000000` | the minimal passive trait: `feat`, `properties: ["trait"]`, `activities: {}` |

Do not "improve" them to match the code; the code must match them. Re-extract after a system
update (read-only, nothing is created in the world).

Content is SRD 5.1/5.2 material from the dnd5e system, licensed CC-BY-4.0 (the
`system.source.license` field inside the documents carries the attribution).

## What 6.0 changed for the converter (all proven by these files and the system source)

The 5.3.3 layout still loads, because dnd5e migrates it, but the migrated paths are **not stored**,
so a write that carries them can never read back (the strict read-back in `import_npc` fails).

| Concern | 5.3.3 | 6.0.5 |
|---|---|---|
| Armor class | `ac: {flat, calc: "natural"}` | `ac: {flat, calcs: ["natural"]}`; a fixed AC is `ac.override`. `ac.calc` and `ac.formula` are derived, not persisted |
| Movement | `movement.walk: "30"` | `movement.speeds.walk: "30"`; absent speeds are simply absent |
| Skill delta | `skills.<k>.bonuses.check: "2"` | `skills.<k>.roll.bonus: "2"` |
| Save delta | `abilities.<a>.bonuses.save: "1"` | `abilities.<a>.save.roll.bonus: "1"` |
| Senses | `senses.darkvision: 60` | `senses.ranges.darkvision: 60` (the converter already used this) |
| Legendary resources | `resources.legact: {value, max}` | `{max, spent}`; `value` is derived |
| Empty legacy bonus paths | `bonuses.*` with `""` | dropped |

Skill proficiency `value` stays the proficiency **multiplier** (never the printed total), and
`abilities.<abl>.proficient: 1` marks a save proficiency.

Items (`feat`, `weapon`, activities, `uses.recovery`, `damage.base`): every key the converter emits
is present in these documents (`test/integration/statblock-schema-parity.test.ts`), and the converted
actors read back clean in a real 6.0.5 world (see the pull request that introduced this directory).
