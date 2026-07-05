# Plan: Obsidian Fantasy Statblocks ⇄ dnd5e NPC actor sync

Goal: a 1:1, **bidirectional** mapping between Obsidian [Fantasy
Statblocks](https://plugins.javalent.com/statblocks) creature blocks and dnd5e
NPC actors in a running Foundry world — where the Foundry side **works like the
official compendium monsters** (rollable attacks, saves, damage, legendary
actions), not like a text dump that merely looks right on the sheet.

> **Executing this?** Follow `docs/statblock-import-execution-plan.md` — the
> ordered milestone checklist with per-step verification gates for the
> import direction.

This builds on the existing `packages/campaign-sync` Obsidian↔Foundry sync
(manifest, hashing, planner, world export), which today syncs actors only
shallowly (`cr`, `hp`, biography in `world-export.ts:141`). The plan replaces
that shallow actor path with a full statblock converter, and adds the two
protocol commands needed to make the Foundry side official-grade.

## 1. The core problem: presentational vs. mechanical data

A Fantasy Statblocks block is **presentational** — actions are prose:

```yaml
actions:
  - name: Scimitar
    desc: "Melee Attack Roll: +4, reach 5 ft. Hit: 5 (1d6 + 2) Slashing
           damage."
```

A modern dnd5e NPC (dnd5e 4.x+, verified against `foundryvtt/dnd5e` HEAD,
system.json 6.0.0) is **mechanical**: the actor document carries a deep
`system` object (abilities, attributes, details, traits, skills, spells,
resources) plus **embedded items** (`weapon` / `feat` / `equipment` / `spell`),
and each item carries `system.activities` — typed activity objects
(`attack`, `damage`, `save`, `utility`) with structured attack ability,
damage parts, range, activation. That is what makes the sheet roll like an
official monster (see the weapon items with their `attack` activities in
`packs/_source/actors24/fey/goblin-warrior.yml` of the dnd5e repo — note 2024
also reclassified the goblin's creature type from `humanoid` to `fey`,
alongside splitting it into warrior/boss/minion variants; the item/activity
structure itself is the same as the 2014 `packs/_source/monsters/humanoid/
goblin.yml`, just with 2024 grammar in the description text).

A naive text→field converter can never synthesize official-quality items
reliably. So conversion to Foundry is **tiered**, preferring official data at
every level:

| Tier | When | How | Fidelity |
|------|------|-----|----------|
| 1. Actor match | Statblock is an SRD/compendium monster (by name, or an explicit `foundryUuid`/`source` key) | Clone the official actor from the world's compendia (`dnd5e.monsters` 2014 / `dnd5e.actors24` 2024, plus any premium modules the user owns), then patch statblock deltas on top | Perfect |
| 2. Item match | Homebrew monster, but individual traits/actions have official names ("Nimble Escape", "Pack Tactics", "Scimitar") | Clone matching items from `dnd5e.monsterfeatures24` (391 entries) / `dnd5e.equipment24` compendia, falling back to the 2014 `dnd5e.monsterfeatures` (252) / `dnd5e.items` on miss; patch numbers (attack bonus, DC, damage) parsed from the desc text | Near-perfect |
| 3. Synthesis | Fully custom action text | Parse the rigid 5e statblock grammar (`Melee Weapon Attack: +X to hit, reach Y ft.` / `Hit: N (XdY+Z) <type> damage` / `DC X <Ability> saving throw`) and synthesize a weapon/feat item with real activities | Rolls correctly |
| 4. Fallback | Unparseable text | `feat` item with description only, flagged `flags.foundry-mcp-bridge.needsReview: true` | Displays; doesn't roll |

The tier used per action is recorded in the actor's flags so a later re-sync
(or a human) can upgrade it.

## 2. Ground truth: the dnd5e repo is the test oracle

`foundryvtt/dnd5e` ships every SRD monster as source YAML:

- `packs/_source/actors24/**` — 2024 SRD actors (380 files, full actor JSON
  incl. embedded items + activities, `_key: '!actors!<id>'`) — primary source
- `packs/_source/monsters/**` — 2014 SRD actors (331 files) — legacy/fallback
- `packs/_source/monsterfeatures24/**` — 391 reusable trait/action items —
  primary source
- `packs/_source/monsterfeatures/**` — 252 reusable trait/action items —
  legacy/fallback
- `packs/_source/spells24/**`, `equipment24/**` (falling back to `spells/**`,
  `items/**`) — for spellcasters and weapons

Strategy: **vendor a curated fixture set** (~10 actors covering the axes:
goblin = simple humanoid, ogre = brute, mage = spellcaster, adult red dragon =
legendary actions + breath save + `system.resources.legact`, swarm, celestial
with innate spellcasting) into `test/fixtures/dnd5e-srd/` — drawn primarily
from `actors24` (2024 is the default rules version, §3) with 2014
counterparts from `monsters` for the legacy grammar path — with a
`scripts/refresh-dnd5e-fixtures.ts` that re-pulls them from a dnd5e checkout.
License is CC-BY-4.0 — include the attribution notice in the fixture dir.

These fixtures give both directions a hard oracle:

- **Foundry→statblock**: converting `goblin.yml` must produce exactly the
  known SRD goblin statblock text (AC 15, "Melee Weapon Attack: +4 to hit…").
  This proves we compute derived values the same way the dnd5e system does.
- **Statblock→Foundry**: converting the SRD goblin statblock must produce an
  actor whose *mechanical* subset (abilities, AC calc, HP formula, skills,
  senses, movement, item activities' attack ability/damage parts) deep-equals
  the official actor.
- **Round-trip**: `toStatblock(toFoundry(block)) === block` on the canonical
  subset, in both starting directions.

## 3. Field mapping (the deterministic core)

Fantasy Statblocks' basic 5e layout schema (verified against
`javalent/fantasy-statblocks` `basic5e.ts`) ⇄ dnd5e `system`:

| Statblock | dnd5e actor | Notes |
|---|---|---|
| `name`, `image` | `name`, `img` | |
| `size` ("Small") | `system.traits.size` (`sm`) | word↔code table |
| `type`, `subtype` | `system.details.type.value/.subtype` | |
| `alignment` | `system.details.alignment` | |
| `ac`, `ac_class` | `system.attributes.ac.flat/.calc` | official NPCs use `calc: default` + armor items — Tier 1/2 keeps that; synthesis uses `flat`/`natural` |
| `hp`, `hit_dice` | `system.attributes.hp.max/.formula` | `2d6` ↔ "7 (2d6)" |
| `speed` string | `system.attributes.movement` object | "30 ft., fly 60 ft. (hover)" parser + renderer |
| `stats: [8,14,10,10,8,8]` | `system.abilities.*.value` | |
| `saves: [{dexterity: 2}]` | `system.abilities.*.proficient` | proficiency = (bonus − mod) / profBonus(CR); non-integer → flat `bonuses.save` |
| `skillsaves: [{stealth: 6}]` | `system.skills.*.value` (0/1/2) | same derivation; skill-name↔`ste` code table |
| `damage_vulnerabilities/_resistances/_immunities`, `condition_immunities` | `system.traits.dv/dr/di/ci` | comma string ↔ `value[]` + `custom` |
| `senses` | `system.attributes.senses` | "darkvision 60 ft., passive Perception 9" — passive is derived, never stored |
| `languages` | `system.traits.languages` | |
| `cr` ("1/4") | `system.details.cr` (0.25) | |
| `traits` | `feat` items (passive) | Tier 2 match against `monsterfeatures24` first, then `monsterfeatures` |
| `actions`, `bonus_actions`, `reactions` | `weapon`/`feat` items with activities; activation type action/bonus/reaction | |
| `legendary_actions`, `legendary_description` | `feat` items (activation `legendary`) + `system.resources.legact` | count parsed from description ("can take 3 legendary actions") |
| `lair_actions`, `regional_effects` | `feat` items (activation `lair`) / description-only feats | |
| `spells`, `spellsNotes` | Spellcasting feat + embedded `spell` items + `system.spells` slots + `system.attributes.spellcasting` | spell names matched against the `spells` compendium; unmatched → flagged placeholder spell |

Reverse direction (Foundry→statblock) is mostly **rendering**: recompute what
the sheet displays — ability mods, prof bonus from CR, attack bonus =
mod + prof + activity bonus, average damage `⌊avg(XdY)⌋+Z` — and emit canonical
statblock prose per activity. Where dnd5e's own description text exists
(official items embed `[[/attack]]`/`[[/damage]]` enrichers), render from the
activity data, not the enricher string, so output is uniform.

**2014 vs 2024:** 2014 statblocks use "Melee Weapon Attack: +4 to hit…" while
2024 uses "Melee Attack Roll: +7, reach 5 ft. Hit: …" (verified in
`actors24`). Config flag `rulesVersion: "2024" | "2014"` selects which grammar
the renderer emits and which compendium pair Tier 1/2 searches first
(`actors24`/`equipment24` vs `monsters`/`monsterfeatures`/`items`);
**default 2024**. The parser accepts both grammars regardless of the flag, so
pasted 2014-style homebrew still converts under the 2024 default. 2024 has
the richer packs at HEAD (380 `actors24` NPCs / 391 `monsterfeatures24` traits
vs. 331 `monsters` / 252 `monsterfeatures`), so Tier 1/2 matching against
2024 compendia is expected to have equal-or-better hit rate than 2014 — no
2014 fallback needed for coverage. Where a 2024 trait/action has no
2024-pack counterpart, Tier 2 still checks the 2014 packs as a secondary
source before falling to Tier 3 synthesis.

## 4. New protocol commands (via the `add-foundry-command` lockstep)

The bridge's `create` command already takes free-form `data`, and
`Actor.create` accepts embedded `items` in the payload — so Tier 3/4 needs no
protocol change. Tiers 1–2 need compendium access, which the protocol lacks
entirely today:

1. **`searchCompendium`** — `{ packScope?: "dnd5e", documentType, nameQuery }`
   → `[{ uuid, pack, name, type, cr? }]` from the world's compendium indices.
   Read-only; used by the matcher to discover what the *live world* actually
   has (SRD packs, premium modules — often better art/data than SRD).
2. **`importFromCompendium`** — `{ uuid, patch?, folder? }` →
   `fromUuid(uuid)` → `doc.toObject()` → apply dot-notation patch (reuse
   `packages/shared/src/objects.ts` `applyUpdate`) → create as world document,
   return id. Reliability category: standard create (dry-run capability
   check → write → read-back verify name/type → rollback delete on
   mismatch).

Each lands across `packages/shared/src/protocol.ts` → executor →
`FoundryDocumentApi` → `foundry-runtime.ts` → `mock-foundry` (give the mock an
in-memory compendium loaded from the vendored fixtures — this is what makes
Tier 1/2 testable in CI) → test doubles → MCP tools (`search_compendium`,
`import_from_compendium`).

## 5. Package layout: `packages/statblock-sync`

Pure, mock-first converter package (no Foundry globals, no I/O), consumed by
`campaign-sync` and usable standalone:

```
packages/statblock-sync/src/
  schema.ts        # zod schema for the Fantasy Statblocks basic5e block
  parse.ts         # note ⇄ statblock: extract/replace the ```statblock fence
  grammar.ts       # 5e action-text grammar: attack/save/damage/recharge parsers + renderers
  derive.ts        # shared 5e math: mods, prof-from-CR, save/skill derivation, avg damage
  to-foundry.ts    # statblock → { actorData, matchPlan }  (tiers; takes a CompendiumIndex)
  from-foundry.ts  # dnd5e actor JSON → statblock
  ownership.ts     # canonical subset + field-ownership rules (below)
```

`to-foundry` returns a **match plan** (per action: tier, uuid or synthesized
item) separately from the final actor data, so the sync layer can execute
Tier 1 as a single `import_from_compendium` + patch instead of a raw create.

## 6. Sync semantics (extends campaign-sync, doesn't fork it)

- **Note format:** an NPC note is a normal Obsidian note whose statblock lives
  in a ```` ```statblock ```` fence (Fantasy Statblocks' native form). Sync
  parses and rewrites **only the fence**, preserving the user's surrounding
  prose. Front-matter keeps sync identity: `foundryId`, `foundryUuid` (for
  Tier 1), `rulesVersion`.
- **Ownership split** (the key to safe bidirectionality):
  - *Statblock-owned:* the canonical subset in §3. Push overwrites these;
    pull rewrites the fence when they change remotely.
  - *Foundry-owned (never pushed, never hashed):* runtime state — current
    `hp.value`, temp HP, exhaustion, effects, token placement, currency,
    `_stats`. Mirrors campaign-sync's existing `MANAGED_KEYS` pattern.
  - *Item identity:* pushed items get
    `flags.foundry-mcp-bridge.statblockKey: "actions/scimitar"` so updates
    diff item-by-item (update matched, create new, delete removed items) via
    the existing `createEmbedded`/`updateEmbedded`/`deleteEmbedded` commands,
    instead of wiping items the GM added by hand.
- **Change detection:** content hash of the *canonical statblock subset* (not
  raw YAML text), so key reordering or comment edits don't cause spurious
  pushes. Remote side: hash `from-foundry(actor)` — a GM edit to a synced
  field shows up as `remote-ahead`/`conflict` in the existing planner exactly
  like journals do today. `_stats.modifiedTime` alone is too noisy (HP damage
  ticks it), which is why the remote hash must be over the canonical subset.
- **World export** (`world-export.ts`): `actorNote()` for `type: "npc"`
  becomes "front-matter + prose body + statblock fence" via `from-foundry` —
  so a fresh export of an existing world immediately yields Fantasy-Statblocks-
  renderable notes and a manifest where everything plans `unchanged`.

## 7. Phases

Each phase ends green through the `verify-bridge` gate (build → typecheck →
test → selftest where the live path is touched).

- **Phase 0 — fixtures + oracle harness.** Vendor SRD fixtures + attribution,
  fixture loader, `CompendiumIndex` abstraction, golden statblock texts for
  the fixture monsters. *(No behavior change.)*
- **Phase 1 — Foundry → statblock.** `schema/derive/grammar(render)/
  from-foundry`; wire into `world-export`. Oracle: fixtures render to the
  known SRD statblocks. Ships standalone value: full-fidelity NPC export.
- **Phase 2 — compendium protocol.** `searchCompendium` +
  `importFromCompendium` end-to-end via the add-foundry-command lockstep;
  mock compendium backed by the fixtures.
- **Phase 3 — statblock → Foundry.** `grammar(parse)/to-foundry` with the
  four tiers + match plan. Oracle: SRD statblocks reproduce official actors'
  mechanical subset; round-trip tests both directions.
- **Phase 4 — sync integration.** Fence rewrite, ownership rules, item-level
  diffing, planner integration (actor notes get statblock-aware hashing),
  manifest recording. Round-trip test: export world → edit statblock → plan →
  push → re-export → `unchanged`.
- **Phase 5 — live verification.** Extend `npm run selftest`: import Goblin
  via Tier 1 into the live world, push a homebrew statblock via Tier 3, read
  back and assert activities exist and reference resolvable damage formulas.
  Manual: open the sheet, click the attack, watch it roll.
- **Phase 6 — token framing (optional, independent).** `tokenizeActor`
  command (§9) + sync-layer wiring for Tier 3/4 actors. Doesn't block phases
  0–5; can land whenever, and only matters to worlds with Tokenizer
  installed.

## 8. Risks & open questions

- **2024 isn't a text-only revision of 2014.** Some monsters were
  reclassified (Goblin: `humanoid`→`fey`) or split into named variants
  (Goblin → Goblin Warrior/Boss/Minion in `actors24/fey/`) with no 1:1
  `monsters`↔`actors24` name match. Tier 1's name-match needs a
  small curated alias table for known splits/renames (build it once from a
  diff of the two packs by CR+role), and should present the 2024 variant
  choice in the confirmation step (§8, premium-content matching) rather than
  guessing which variant a bare "Goblin" statblock means.
- **Grammar variance.** Homebrew desc text strays from SRD phrasing; the
  grammar must degrade to Tier 4 (never guess numbers). Recharge ("Recharge
  5–6"), multiattack (no mechanical form — stays a description-only feat,
  as in official data), and "versatile" weapon text need explicit cases.
- **dnd5e version drift.** Activities require dnd5e 4.x+; the data shapes here
  are from HEAD (6.0). Gate on `getWorldInfo` system version and record the
  tested range in one place (`statblock-sync/src/compat.ts`).
- **Premium-content matching.** Tier 1 across non-SRD packs matches by
  (name, type, CR) — needs a confirmation step in the sync plan output before
  cloning, to avoid wrong-monster surprises.
- **Fantasy Statblocks `extends`.** Blocks can inherit from bestiary entries;
  phase 1–4 treat blocks as self-contained, `extends` resolution is a later
  enhancement (resolve against the vendored SRD bestiary).
- **Images/tokens.** `image` maps to `img`; token art upload rides the
  existing asset pipeline (`uploadAsset`) — Tier 1 clones official tokens,
  which is usually what "works like official" means visually too. Tier 3/4
  homebrew NPCs need a separate token-framing step — see §9.

## 9. Token art for synthesized/homebrew NPCs (Tokenizer)

Tier 1 imports already get official token art for free (cloned straight from
the compendium actor). Tier 3/4 — a fully homebrew statblock, or one where
only a portrait exists (e.g. produced by the existing
`generate-and-upload-image` skill) — has no framed token, just a raw
rectangular image. [`MrPrimate/tokenizer`](https://github.com/MrPrimate/tokenizer)
(module id `vtta-tokenizer`) is the standard Foundry tool for turning that
into a proper circular/bordered token, so it's the natural last step for
those tiers.

**Why it fits this architecture specifically:** Tokenizer is a browser-side
Foundry module exposing a JS API
(`game.modules.get("vtta-tokenizer").api`) — it cannot be driven headlessly
from Node, only from inside a live, logged-in Foundry client. That's exactly
where `packages/foundry-module` already runs (per this repo's architecture,
`foundry-runtime.ts` already calls real Foundry/document APIs from that same
browser context), so wiring it in is a natural extension rather than a new
integration surface:

- `autoToken(actor, options)` applies the default frame **without an
  interactive dialog** and updates the actor's image — the one function of
  the four (`launch`, `autoToken`, `tokenizeActor`, `tokenizeSceneToken`)
  that's actually automatable, since the others open an editor UI.

**Proposed integration — a new optional protocol command:**

- `tokenizeActor` — `{ actorId }` → in `foundry-runtime.ts`, check
  `game.modules.get("vtta-tokenizer")?.active`; if absent, return a clear
  `ok: false` result naming the missing module (never a hard failure — token
  framing is cosmetic, not blocking); if present, call
  `api.autoToken(game.actors.get(actorId))` and await it.
- Runs through the same `add-foundry-command` lockstep as any other command,
  but the mock side is trivial: `mock-foundry-api.ts` just records that
  tokenize-was-called (or errors if a test wants to simulate "module not
  installed") — there's no real frame/mask logic to fake, since actual
  compositing only ever happens in a live Foundry browser.
- Reliability category: fire-and-forget, no read-back (like quest pushes) —
  a mis-framed token isn't a correctness problem the read-back/rollback
  machinery needs to guard, unlike actor mechanical data.
- Sync integration: `to-foundry.ts`'s Tier 3/4 path emits `needsToken: true`
  on the match plan; the sync layer calls `tokenizeActor` as the final step
  right after the actor create/update, only for actors that came in below
  Tier 1.

**Without any bridge changes**, the same result is reachable today via a
GM-run Foundry macro that loops actors flagged `needsReview` (or any
selection) and calls `autoToken` on each — useful for validating the UX
before investing in the protocol command.

