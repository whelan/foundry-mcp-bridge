---
name: write-statblock
description: Write a new Obsidian Fantasy Statblocks note (or edit an existing one) for import into Foundry, then lint it against the 2024-only grammar packages/statblock-sync actually accepts. Use when the user wants to "create/write a statblock", "make an NPC note", "add a monster for import", or asks to check a statblock is "2024" / will import correctly. The lint is mandatory — a statblock that lints clean is guaranteed to convert the same way it read, mirroring the real converter's own parser functions.
---

# Write a statblock, then lint it against the 2024 grammar

**This bridge is 2024-only.** `packages/statblock-sync/src/grammar.ts` deliberately
does not recognize 2014-style action text — a 2014 attack ("Melee Weapon Attack:
+5 to hit") or 2014 save prose ("...DC 15 Constitution saving throw...") silently
imports as a **non-rollable, description-only feat**, with no error at all. The
lint script exists specifically to catch this before import, because nothing else
will.

## Workflow

1. Write the note as a `.md` file with a fenced ` ```statblock ` YAML block (see
   grammar below and `test/fixtures/statblock-import/gravemire-stalker.md` /
   `duskfang-bog-wyrm.md` for worked examples — Duskfang covers legendary + lair
   actions too).
2. Lint it:
   ```bash
   npm run lint:statblock -- path/to/your-note.md
   ```
   (Omit the path to lint every fixture under `test/fixtures/statblock-import/`.)
3. Fix every `FAIL` — it means an action *reads* like it should roll but won't.
   `WARN` (e.g. an unrecognized damage-type token) is worth a look but not fatal.
4. Re-run until `LINT PASSED`. Only then is the note ready to import.

The lint (`scripts/lint-statblock.mjs`) is not a reimplementation — it imports
`parseAttackAction`/`parseSaveAction`/`statblockToFoundryActor` directly from
`@foundry-mcp-bridge/statblock-sync`, the exact functions the real importer
uses. A note that lints clean converts identically; the lint can't drift from
the converter because it *is* the converter.

## The 2024 grammar (what to write)

**Attack actions** — the header must read exactly:
```
Melee Attack Roll: +5, reach 5 ft. Hit: 10 (2d6 + 3) slashing damage.
Ranged Attack Roll: +4, range 60/240 ft. Hit: 7 (2d6) piercing damage.
```
Not `"Melee Weapon Attack: +5 to hit"` (2014) — that silently fails to parse.
Extra damage: `"... plus 3 (1d6) necrotic damage."`

**Save actions** — the header must lead with the ability, not the DC:
```
Constitution Saving Throw: DC 15, each creature in a 15-foot cone.
Failure: 22 (4d10) poison damage. Success: Half damage.
```
or the flowing form `"...or half as much damage on a successful save."` Not
`"...must succeed on a DC 15 Constitution saving throw..."` (2014 DC-first
prose) — that also silently fails to parse, even though it reads correctly to
a human. **This is the single most common mistake** — legendary and lair
actions are especially prone to it, since real published 2014-era lair-action
text uses exactly this word order.

**Recharge:** append `(Recharge 5-6)` (or `(Recharge 5)`) to the action's
`name`.

**Legendary / lair actions:** separate top-level YAML lists, `legendary_actions:`
and `lair_actions:` — same `name`/`desc` shape as `actions`/`reactions`. Both
get their own dnd5e activation type (`"legendary"` / `"lair"`), not a normal
action-economy slot.

**Damage-type lists** (`damage_resistances`/`_immunities`/`_vulnerabilities`):
plain comma lists are fine, including an Oxford "and" (`"cold, fire, and
lightning"` splits correctly). A conditional clause must stay a single
semicolon-separated segment if it's mixed with an unconditional one:
`damage_resistances: "cold; bludgeoning, piercing, and slashing from nonmagical attacks"`
— never let the qualifier ("...from nonmagical attacks") land in the same
comma-separated segment as an unconditional type, or the qualifier is lost and
the type becomes unconditional.

**CR:** a number or a fraction string (`"1/2"`, `"1/4"`, `"1/8"`) — both parse
correctly.

## What the lint checks (and won't catch)

Checks: every action against the real attack/save parsers (catching 2014-style
and malformed-2024 text before it silently becomes non-mechanical); every
damage-type list entry against the known-type set; CR resolves to a real XP
value; the whole statblock actually survives `statblockToFoundryActor` without
throwing.

Won't catch: whether the numbers themselves are *correct* 5e math (to-hit vs.
ability+proficiency, DC vs. ability+proficiency) — the lint only checks that
text *parses*, not that it's balanced. Won't catch missing legendary-action
resource counts in prose (`"can take 3 legendary actions..."`) — that's
flavor text on the actor, not modeled mechanically at all.

## After it lints clean

If the note is meant to become a permanent test fixture, put it in
`test/fixtures/statblock-import/` (alongside a matching placeholder PNG for
`image:`, if the note has one) and add it to the relevant test file, following
`statblock-import.test.ts`'s pattern. Otherwise it's ready to import as-is via
the `import_npc` flow (see `docs/statblock-import-execution-plan.md`).
