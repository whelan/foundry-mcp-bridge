# Execution plan: import an Obsidian statblock NPC into Foundry, verified

> **Who runs what.** M0–M5 touch only the mock and the source tree — a cloud
> Claude Code session (this kind of session, no access to your machine or
> your Foundry) executes and gates all of them, fully automated, no live
> world involved. M6 needs a real WebSocket to a real relay, which this kind
> of session cannot reach; it must run from **your local Claude Code
> session** (see `docs/local-test-quickstart.md`) — for the local-world pass
> directly, and for the Forge pass too, since your local machine can reach a
> `wss://` relay just as well as the GM's Forge browser can (see
> `docs/setup-foundry-forge.md` §5). Each of the two M6 passes has an
> **automated half** (AI-run, structured pass/fail, no eyeballing) that must
> go green before the **manual half** (you, in the browser) — never the
> other order.

This is the **executable companion** to
`docs/obsidian-statblock-npc-sync-plan.md` (the design doc). Where the design
doc explains *what and why*, this doc is the ordered checklist to *do it*:
each milestone lists the files to touch, the exact verification commands, and
a pass/fail gate. Execute the milestones in order; do not start a milestone
until the previous gate is green. Every gate ends with the repo's standard
`verify-bridge` sequence (`npm run build && npm run typecheck && npm test`,
plus `npm run selftest` when the live path is touched).

**Scope choice that makes this plan short:** the goal is "an NPC written with
Obsidian Fantasy Statblocks imports into Foundry and works". That is the
**Tier 3 synthesis path** of the design doc — and it needs **no new protocol
commands**: the existing `create` command already accepts embedded `items` in
its free-form `data`, and the reliability pipeline (dry-run → write →
read-back → rollback) already covers actor creation. Compendium matching
(Tiers 1–2, design doc §4) is a *quality upgrade*, not a prerequisite, so it
comes last here and everything before it works without it.

## The acceptance NPC

This statblock is the thread through every milestone. It deliberately
exercises: abilities, natural AC, HP formula, mixed movement, skills, a save
proficiency, damage resistance, darkvision + passive perception, a passive
trait, a multiattack, a weapon attack, a save-based ability with recharge,
a reaction — and a **portrait image** (`image:` is a vault-relative path;
a test PNG lives next to the note), so the image → portrait → token pipeline
is verified together with the mechanics, not as an afterthought.

````markdown
```statblock
name: Gravemire Stalker
image: gravemire-stalker.png
size: Medium
type: undead
alignment: Neutral Evil
ac: 14
ac_class: natural armor
hp: 45
hit_dice: 7d8+14
speed: 30 ft., swim 20 ft.
stats: [16, 14, 15, 6, 12, 8]
saves:
  - wisdom: 3
skillsaves:
  - stealth: 4
  - perception: 3
damage_resistances: necrotic
condition_immunities: charmed
senses: darkvision 60 ft., passive Perception 13
languages: understands Common but can't speak
cr: 3
traits:
  - name: Stench of the Grave
    desc: "Any creature that starts its turn within 5 feet of the stalker
      must succeed on a DC 12 Constitution saving throw or be poisoned
      until the start of its next turn."
actions:
  - name: Multiattack
    desc: "The stalker makes two Claw attacks."
  - name: Claw
    desc: "Melee Attack Roll: +5, reach 5 ft. Hit: 8 (1d10 + 3) Slashing
      damage plus 3 (1d6) Necrotic damage."
  - name: Grave Breath (Recharge 5-6)
    desc: "Constitution Saving Throw: DC 12, each creature in a 15-foot
      cone. Failure: 14 (4d6) Poison damage. Success: Half damage."
reactions:
  - name: Grasp of the Mire
    desc: "When a creature within 5 feet of the stalker moves away, the
      stalker makes one Claw attack against it."
```
````

The final acceptance test (M7) is: this note, pushed through the sync, opens
in Foundry as an NPC whose sheet **rolls** — Claw makes an attack roll at +5
and damage of 1d10+3 slashing + 1d6 necrotic; Grave Breath prompts a DC 12
CON save; the numbers on the sheet header (AC 14, HP 45, speed, senses,
passive Perception 13) match the block — **and** the sheet shows the
uploaded portrait while a dragged-out token shows token art (the framed
`.Token.webp` when Tokenizer is installed, the portrait otherwise).

### The image → portrait → token pipeline

The `image:` field flows through three stages, each independently verifiable:

1. **Upload** — the vault-relative file is uploaded via the existing asset
   pipeline (`uploadAsset`, content-hash tracked in the manifest exactly like
   scene assets today) to a remote path under the world's data dir.
2. **Portrait + baseline token** — the actor is created with `img` *and*
   `prototypeToken.texture.src` both pointing at the uploaded path (the
   `create` command's free-form data already carries `prototypeToken`).
   Without any extra module, that is the complete, working baseline: sheet
   portrait and scene token both show the artwork.
3. **Framed token (optional upgrade)** — in a world with `vtta-tokenizer`
   enabled, the `tokenizeActor` step (design doc §9) runs `autoToken` after
   creation; the actor ends with `img` → `<name>.Avatar.webp` and
   `prototypeToken.texture.src` → `<name>.Token.webp`. Worlds without the
   module keep the stage-2 baseline — the import never fails over cosmetics.

Verification is therefore **two-mode** everywhere below: *baseline* checks
(img and token texture set, equal, and pointing at the uploaded asset) always
run; *Tokenizer* checks (distinct `.Avatar.webp` / `.Token.webp` paths) run
only when the world reports the module active.

---

## M0 — Fixtures and oracle harness

**Build:** vendor the SRD fixture set (design doc §2) into
`test/fixtures/dnd5e-srd/` from a dnd5e checkout: `actors24` primary
(goblin-warrior, ogre variant, mage, adult red dragon, one swarm), 2014
`monsters` counterparts, ~20 `monsterfeatures24` items, plus the CC-BY-4.0
attribution file and `scripts/refresh-dnd5e-fixtures.ts`. Add a fixture
loader and hand-write the **golden statblock text** for two of them (goblin
warrior, ogre) as the oracle.

**Verify (gate):**
- `npx vitest run -t "fixtures"` — loader parses every vendored YAML into the
  actor JSON shape (zod-validate `name`, `type: "npc"`, `system.abilities`,
  `items[].system.activities` present on at least one weapon per actor).
- `npm run build && npm run typecheck && npm test` green.

## M1 — Statblock schema + note parsing

**Build:** `packages/statblock-sync` package skeleton;
`schema.ts` (zod schema of the Fantasy Statblocks basic-5e fields, design doc
§3 table, tolerant of both `saves: [{wisdom: 3}]` and object forms);
`parse.ts` (extract/replace the ```` ```statblock ```` fence in a note,
preserving surrounding prose byte-for-byte). Also commit the acceptance
fixture itself — real files, not just the copy in this doc — at
`test/fixtures/statblock-import/gravemire-stalker.md` (the exact note from
§"The acceptance NPC" above, `image:` pointing at the sibling file below) and
`test/fixtures/statblock-import/gravemire-stalker.png` (any small real PNG;
content doesn't matter, only that it's a valid image the upload pipeline can
handle). Every later milestone and the M7/M6 commands reference this one
path — nothing downstream invents its own copy.

**Verify (gate):**
- Unit test: the acceptance NPC above parses with zero unknown-key warnings;
  every field lands typed.
- Unit test: `image:` resolves against the vault root (both plain relative
  paths and Obsidian `[[wikilink]]` embeds); a referenced-but-missing file is
  a named error at parse/scan time — before anything is written to Foundry —
  matching the repo's fail-loudly config convention.
- Unit test: fence replacement on a note with prose above/below leaves prose
  identical; `replace(parse(note)) === note` when nothing changed.
- Property: parse rejects (with a named-field error, not a crash) a block
  missing `name`.
- `verify-bridge` sequence green.

## M2 — Derived 5e math (`derive.ts`)

**Build:** the pure math both directions share: ability mods, proficiency
bonus from CR, save/skill proficiency derivation (design doc §3: value =
(bonus − mod) / prof, non-integers → flat bonus), average-damage ↔ dice
(`8 (1d10 + 3)`), CR string ↔ number (`1/4` ↔ 0.25), size/skill/language
code tables, speed and senses string ↔ object parsers/renderers.

**Verify (gate):**
- Table-driven unit tests for every converter, **fixture-anchored**: goblin
  warrior's stealth from the fixture must derive to the same skill `value`
  the official actor carries; the acceptance NPC's `passive Perception 13`
  must equal the derived value (10 + WIS mod 1 + prof 2).
- Round-trip property per converter: `render(parse(x)) === x` over the SRD
  golden texts.
- `verify-bridge` green.

## M3 — Action-text grammar (`grammar.ts`)

**Build:** parser + renderer for the **2024** statblock action grammar
("Melee Attack Roll: +5, reach 5 ft. Hit: …", "Constitution Saving Throw:
DC 12, …"), plus `Recharge X-Y`, multi-part damage ("plus 3 (1d6) Necrotic"),
and the explicit **give-up result**: anything unparsed returns
`{ kind: "unparsed", text }` — never guessed numbers (design doc §8).

**Scope decision — 2024-only.** The converter deliberately does **not**
recognize the 2014 grammar ("Melee Weapon Attack: +5 to hit…", the DC-first
"…DC 12 Constitution saving throw…" prose). 2014-form text falls through to a
description-only feat instead of being silently mis-parsed. (The design doc's
`rulesVersion` flag is therefore unused — there is only the 2024 grammar.)

**Verify (gate):**
- Unit tests: all four acceptance-NPC actions parse to the expected
  structures (Multiattack → `unparsed` by design; Claw → attack +5, two
  damage parts; Grave Breath → save DC 12 CON, recharge 5–6, half-on-success;
  reaction → activation `reaction`).
- Oracle test: for every attack action in the vendored fixtures, parsing the
  item's *rendered* description reproduces the attack bonus and damage the
  item's activity actually carries (grammar agrees with dnd5e's own math).
- Fuzz guard: a corpus of ~10 deliberately mangled desc strings all land in
  `unparsed`, none throw.
- `verify-bridge` green.

## M4 — Statblock → actor JSON (`to-foundry.ts`, Tier 3/4 only)

**Build:** assemble the full dnd5e NPC document: `system` from M2, embedded
items from M3 (weapon items with `attack` activities, feat items with `save`
/ description-only activities, activation type from the section the action
came from, recharge → `uses.recovery`), `prof`-correct attack ability chosen
so mod + prof reproduces the stated bonus (flat bonus fallback when no
ability fits), Tier 4 fallback items flagged
`flags.foundry-mcp-bridge.needsReview`, every item flagged
`flags.foundry-mcp-bridge.statblockKey`. `to-foundry` takes the image's
**already-resolved remote path** as an input (upload happens in the sync
layer, M5) and sets both `img` and `prototypeToken.texture.src` to it; no
image → both omitted so Foundry's defaults apply.

**Verify (gate):**
- **The mechanical-subset oracle:** `to-foundry(golden goblin statblock)`
  deep-equals the official fixture actor on the canonical subset (abilities,
  hp.max/formula, movement, senses, skills with proficiency, traits.di/dr/ci,
  details.cr/type/alignment, and per-item: activity type, attack ability,
  damage parts, activation).
- Acceptance NPC test: produces exactly 5 items (1 feat trait, 1 multiattack
  feat, 1 claw weapon, 1 breath feat with save activity, 1 reaction feat);
  claw activity resolves to STR-based (+3 mod +2 prof = +5); breath has
  `recovery: recharge 5`; `img` and `prototypeToken.texture.src` both equal
  the supplied remote path.
- Round-trip: `from-foundry` is Phase-1 work in the design doc and **not**
  required here — but add the one-way invariant now: converting the output
  actor's items' activities back through the M3 *renderer* reproduces the
  input desc strings for Claw and Grave Breath.
- `verify-bridge` green.

## M5 — Import path through the bridge (mock end-to-end)

**Build:** an `import-npc` entry point (in `statblock-sync`, callable from
the campaign-sync CLI and as an MCP flow): note file in → parse →
**upload the referenced image** (existing `uploadAsset`, content-hash
recorded in the manifest like scene assets) → to-foundry with the returned
remote path → existing `create_document` (Actor, with `items` and
`prototypeToken` in data) through the reliability pipeline → *(once the
post-acceptance `tokenizeActor` upgrade has landed:)* token framing when the
world reports vtta-tokenizer active → **post-import verification** read-back
that goes beyond the pipeline's subset check:

```
verifyImportedNpc(transport, actorId, expected):
  # mechanics
  - actor exists, type "npc", name matches
  - item count and names match the match-plan
  - every non-Tier-4 action item has ≥1 activity
  - every attack activity's (ability mod + prof + bonus) === statblock to-hit
  - every save activity's DC === statblock DC
  - hp.max, ac, cr, passive perception match
  # image + token (baseline — always when the statblock has image:)
  - actor.img is set and points at the uploaded asset path
  - prototypeToken.texture.src is set (== img in baseline mode)
  # image + token (tokenizer mode — only when vtta-tokenizer is active
  #                 AND the tokenizeActor upgrade has landed)
  - actor.img ends with .Avatar.webp
  - prototypeToken.texture.src ends with .Token.webp and differs from img
  → returns a structured report { ok, checks: [{name, pass, got, want}] }
```

This report is the machine-readable version of "the NPC works", and it must
be printed by the CLI and returned by the MCP flow.

**Verify (gate):**
- Integration test against `mock-foundry`: import the acceptance NPC note
  (with a real 1×1 test PNG beside it) → `verifyImportedNpc` returns
  all-pass; assert the mock world contains the actor with 5 embedded items,
  the mock FilePicker contains the uploaded portrait, and the actor's `img`
  / `prototypeToken.texture.src` point at it.
- Tokenizer-mode test: mock reports vtta-tokenizer active and fakes
  `autoToken` by rewriting the two paths to `.Avatar.webp`/`.Token.webp` —
  the tokenizer-mode checks pass; with the module absent, the import
  succeeds with baseline checks only (framing must never fail an import).
- Missing-image test: statblock references a file that isn't in the vault →
  structured error naming the path, nothing written to Foundry.
- Failure-path tests (mock injected faults, same style as existing
  reliability tests): read-back mismatch → rollback deletes the actor and the
  report says so; hang → timeout error is structured, world unchanged.
- Idempotence: importing the same note twice with the manifest recorded →
  planner reports `unchanged`, no second actor.
- `verify-bridge` green — including `tsconfig.test.json` (new package is
  referenced by tests; the CLAUDE.md warning about esbuild-only `npm test`
  applies doubly here).

## M6 — Live world verification (two passes, each automated-gate-then-manual)

**Build (once, reused for both passes):** extend `npm run selftest` with an
NPC leg — pushes the acceptance NPC, including the test portrait upload,
through the real server → relay → module → live Foundry world, runs
`verifyImportedNpc` (tokenizer-mode checks included when the live world has
vtta-tokenizer enabled) against the real read-back, **prints the structured
report**, then deletes the actor and the uploaded test assets (selftest must
stay non-destructive — it can run repeatedly against a world you're actively
using).

This leg requires zero human judgment calls: every check in
`verifyImportedNpc` is a programmatic equality, so "green" here is a real,
trustworthy gate — not a proxy for "looks right".

### M6a — Local world, automated gate

Run from **your local Claude Code session** (this cloud session cannot reach
`ws://localhost:8787`):

```bash
npm run install:foundry   # builds + symlinks the module into your Foundry
npm run selftest          # NPC leg included; prints the verifyImportedNpc report
```

**Gate:** `verifyImportedNpc` report is all-pass. Do not proceed to M6b until
it is — a failing automated check means something in M0–M5 doesn't actually
hold against real Foundry (the mock disagreed with reality somewhere), which
is a bug to fix and re-run through M0–M5's gates first, not a manual
workaround.

#### M6a run log (2026-07-06, local world "Test-mcp", Foundry 14.364, dnd5e 5.3.3)

`npm run selftest` was passing (16/16) but proved nothing about the live
world: it has always run its M0–M5 legs *and* the M6 NPC leg against its own
in-process stub relay+module (`ws://localhost:0` + an in-memory `Map`), never
against the real Foundry module. Fixed this first — `scripts/selftest.mjs`
now takes a `--live` flag (`npm run selftest:live`) that binds to the real
relay (`RELAY_URL`, default `ws://localhost:8787` — same config the real MCP
server reads) and waits for the actual module to connect, running only the
M6 NPC leg (the M0–M5 legs aren't cleanup-safe against a real world). Note:
it can't run while a production MCP session already holds the relay port —
only one process can bind it.

Running the real NPC import against the live world (manually, via the
already-connected `mcp__foundry__*` tools, since `--live` couldn't share the
port with this session) surfaced two real bugs the mock never caught:

**Bug 1 — FIXED.** `uploadAsset`/`batchUploadAssets` didn't create the
target directory. Real `FilePicker.upload` returns no path (silently, no
throw) when the target doesn't exist, and `FilePicker.createDirectory` is
**not** recursive like `mkdir -p` — the parent must already exist, one level
at a time creating `worlds/npcs` before `worlds/npcs/gravemire-stalker`
works. Fixed in
[`foundry-runtime.ts`](../packages/foundry-module/src/foundry-runtime.ts)
with an `ensureDirectory` helper that walks the target path segment by
segment before every upload/browse; verified live (uploaded
`worlds/npcs/gravemire-stalker/gravemire-stalker.png` to a brand-new nested
path successfully). **Not yet covered by a regression test** — the mock
never enforced directory existence, which is exactly how this shipped
unnoticed through M0–M5's gates. Fix that (either make the mock enforce the
same constraint, or add a dedicated test) before trusting `npm test` on this
again.

**Bug 2 — NOT FIXED, blocks all Tier 3 imports.** `statblockToFoundryActor`
(`packages/statblock-sync/src/to-foundry.ts`) targets a dnd5e schema that
predates the Activities system (dnd5e 3.0+) and diverges from the live
Actor schema in several places. `create_document` fails immediately at
dry-run: `"The value provided to a LocalDocumentField must be a BaseItem
instance."` Confirmed by diffing against a real actor already in the world
(`MCP Test-kriger`) and by reading the actually-installed dnd5e system's own
compendium data directly (LevelDB packs under
`.../FoundryVTT/Data/systems/dnd5e/packs/`, read with the `classic-level` npm
package — raw `strings` output is Snappy-compressed and unreadable, don't
bother with it):

- Items: weapon-type attacks (Claw, Grave Breath) need a `system.damage.base`
  (`number`/`denomination`/`types`/`bonus`/`custom`/`scaling`) plus a
  `system.activities.<16-char-id>` entry of `type: "attack"` carrying
  `attack: { flat: true, ability: "none", bonus: "<n>", type: { value:
  "melee"|"ranged", classification: "" } }` and `damage: { includeBase: true,
  parts: [] }` (plus activation/duration/range/target/uses/consumption
  boilerplate — see `Rotting Touch` in the `monsterfeatures24` pack for a
  clean real example). The legacy flat fields this repo currently emits
  (`system.damage.parts`, `system.attack.bonus`, `system.save`,
  `system.range`, `system.recharge` directly on the item) no longer exist.
  Passive traits (Multiattack, Stench of the Grave, Grasp of the Mire)
  should be `type: "feat"` with `system.type.value: "monster"` and
  `activities: {}` — not `type: "feature"`, which isn't a valid dnd5e item
  type at all (see `Abduct` in the same pack for reference).
- Actor: `senses` moved from a flat `system.traits.senses` string to
  `system.attributes.senses.ranges.{darkvision,blindsight,tremorsense,
  truesight}` + `.units`/`.special`; damage resistances/immunities/
  vulnerabilities and condition immunities moved from
  `system.traits_.damage{Resistances,Immunities,Vulnerabilities}` /
  `conditionImmunities` to `system.traits.{dr,di,dv,ci}.value` (relocated
  under `traits`, renamed to abbreviations); languages needs a
  `.communication` field alongside `.value`; `system.details.race` is a
  document reference (`null` when unset), not a string — not currently
  modeled at all.

Fixed by the Activities-schema rewrite (see
`docs/superpowers/plans/2026-07-06-dnd5e-activities-schema-rewrite.md`;
ground-truth fixtures in `test/fixtures/dnd5e-53-schema/`). Re-run M6a from
the top (`npm run install:foundry && npm run selftest:live`) to confirm
against the live world.

Follow-up root cause (confirmed from the Ghast fixture): the exact
`LocalDocumentField` error comes from emitting `details.race: { value: "" }`
— on NPCs `race` is a LocalDocumentField (an Item reference, officially
`null`), so a plain object there is rejected at dry-run.

Record the tested version once fixed: dnd5e **5.3.3** on Foundry core
**14.364** (`statblock-sync/src/compat.ts` — not yet created).

**Live-world state left behind:** `worlds/npcs/gravemire-stalker/
gravemire-stalker.png` and `worlds/test-mcp/scenes/selftest-probe.png` were
uploaded to the real "Test-mcp" world while debugging (both tiny placeholder
test images, harmless clutter). No Gravemire Stalker actor was created — the
Tier 3 `create_document` call never succeeded, so nothing needs deleting
there. There's no `delete_asset` command in the bridge, so the two stray
files need manual cleanup (or leave them — they don't hurt anything).

### M6b — Local world, manual verification (you, after M6a is green)

Same checklist either way (local or Forge), ~3 minutes, the definition of
"works like official":

1. Open the Gravemire Stalker sheet: header shows AC 14, HP 45/45,
   speed 30 ft / swim 20 ft, CR 3, senses incl. passive Perception 13.
2. Skills tab: Stealth +4, Perception +3, WIS save +3 shown proficient.
3. Click **Claw** → attack roll appears in chat at **+5**; click damage →
   **1d10+3 slashing + 1d6 necrotic**.
4. Click **Grave Breath** → chat card offers a **DC 12 CON** save;
   recharge die appears on the item.
5. Sheet portrait shows the uploaded Gravemire Stalker artwork (not the
   default mystery-man icon).
6. Drag the actor to a scene → the token renders the artwork,
   vision/darkvision works. With vtta-tokenizer enabled: the token shows
   the **framed** `.Token.webp` (circular border), visibly different from
   the sheet portrait; without it, token art equals the portrait.
7. `needsReview` check: Multiattack shows as a feature with clean text.

Record the tested dnd5e system version in `statblock-sync/src/compat.ts`.

### M6c — Forge, automated gate

Same script, pointed at Forge: set `relayUrl` to a reachable `wss://` (per
`setup-foundry-forge.md` §5 — your local machine's relay is fine, the
Forge browser just needs TLS to reach it) in the module's Settings on your
Forge world, then from the same local Claude Code session:

```bash
npm run selftest    # against the Forge world this time
```

**Gate:** same all-pass `verifyImportedNpc` report. Anything that passed
locally but fails here (asset upload path is the likely culprit — Forge
uploads go through `FilePicker.upload("forgevtt", …)` instead of `"data"`,
per the design doc's forge-asset-manager notes) is a real Forge-specific bug,
not skippable.

### M6d — Forge, manual verification (you, after M6c is green)

Same checklist as M6b, run against the Forge world.

## M7 — Acceptance run (what "done" means)

From a clean checkout, the cloud-automatable part — no live world involved,
`npm test` includes M5's mock-end-to-end suite driving
`test/fixtures/statblock-import/gravemire-stalker.md` through
`verifyImportedNpc` against `mock-foundry`:

```bash
npm install && npm run build && npm run typecheck && npm test
```

…then, handed off to your local Claude Code session (see the handoff prompt
below), M6a (automated) → M6b (manual) → M6c (automated) → M6d (manual), in
that exact order — each automated gate must be green before its manual step,
and the local pass completes fully before Forge starts. When all four
finish, an NPC written with Obsidian Fantasy Statblocks imports into Foundry
and works, on both your local world and Forge.

---

## Handoff prompt for your local Claude Code session

M0–M5 happen in a cloud session (here) and land as ordinary commits/PRs on
`claude/obsidian-foundry-npc-sync-sq6hu6` (or wherever they merge to). Your
local Claude Code session has no memory of this conversation, so give it
this doc and this prompt — it's self-contained:

```
Pull the latest foundry-mcp-bridge branch (or main once merged) and read
docs/statblock-import-execution-plan.md end to end for context.

First, confirm M0-M5 actually landed and are green in this checkout:
  npm install && npm run build && npm run typecheck && npm test
All tests must pass, including anything under packages/statblock-sync and
the mock-end-to-end suite that drives
test/fixtures/statblock-import/gravemire-stalker.md through
verifyImportedNpc against mock-foundry. If anything is missing or red,
STOP and report — do not attempt to patch it yourself; that's cloud-session
work, come back to me instead.

If that's all green, continue with M6 exactly as written in the doc:

1. M6a (local world, automated): run
     npm run install:foundry
     npm run selftest
   and report the full verifyImportedNpc structured report verbatim. If
   any check fails, STOP here and report the failure — do not proceed to
   the manual step and do not attempt to work around it.

2. If M6a is all-pass: STOP and tell me explicitly "M6a is green, ready
   for your manual check (M6b)." Do not run M6c until I tell you I've
   completed M6b.

3. Once I confirm M6b, run M6c (same as M6a, but against my Forge world —
   ask me for the wss:// relay URL if it isn't already in Module Settings
   on that world) and report the result the same way.

4. If M6c is all-pass: STOP and tell me "M6c is green, ready for your
   manual check (M6d)." Do not mark anything done until I confirm M6d.

Do not skip the STOP points even if a step looks obviously fine — the
automated-gate-before-manual-check ordering in the doc is a hard rule, not
a suggestion.
```

---

## After acceptance: quality upgrades (unblocked, optional, any order)

- **Tiers 1–2** (design doc §4): `searchCompendium` + `importFromCompendium`
  via the `add-foundry-command` lockstep, mock compendium from M0 fixtures.
  Upgrades SRD-named NPCs and known trait names to literal official data.
  Verification: importing a note named "Goblin Warrior" yields a clone of
  the compendium actor (compare `_stats.compendiumSource`).
- **Foundry → statblock** (design doc Phase 1) for true bidirectional sync;
  M2/M3 renderers already exist, so this is mostly `from-foundry.ts` plus
  `world-export` wiring, with the golden texts from M0 as the oracle.
- **Token framing** (design doc §9/Phase 6): `tokenizeActor` command calling
  Tokenizer's `autoToken` for Tier 3/4 imports. The verification for it is
  **already specified** above — landing this upgrade activates the
  tokenizer-mode checks in `verifyImportedNpc` (M5), the tokenizer-mode
  selftest leg, and manual checklist item 6's framed-token branch (M6);
  worlds without the module keep passing on baseline checks alone.
