# Execution plan: import an Obsidian statblock NPC into Foundry, verified

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
image: assets/npcs/gravemire-stalker.png
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
preserving surrounding prose byte-for-byte).

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

**Build:** parser + renderer for the statblock action grammar, both 2024
("Melee Attack Roll: +5, reach 5 ft. Hit: …", "Constitution Saving Throw:
DC 12, …") and 2014 ("Melee Weapon Attack: +5 to hit…") forms, plus
`Recharge X-Y`, multi-part damage ("plus 3 (1d6) Necrotic"), and the
explicit **give-up result**: anything unparsed returns
`{ kind: "unparsed", text }` — never guessed numbers (design doc §8).

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

## M6 — Live world verification (the real gate)

**Build:** extend `npm run selftest` with an NPC leg: it pushes the
acceptance NPC — including the test portrait upload — through the real
server → relay → module → live Foundry world, runs `verifyImportedNpc`
(tokenizer-mode checks included when the live world has vtta-tokenizer
enabled) against the real read-back, prints the report, then deletes the
actor and the uploaded test assets (selftest must stay non-destructive).

**Verify (gate):**
- `npm run selftest` green against a live world (local or Forge), NPC leg
  all-pass.
- **Manual sheet checklist** (one-time per dnd5e major version, ~3 minutes,
  this is the definition of "works like official"):
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
- Record the tested dnd5e system version in `statblock-sync/src/compat.ts`.

## M7 — Acceptance run (what "done" means)

From a clean checkout, in order, all green:

```bash
npm install && npm run build && npm run typecheck && npm test
node packages/campaign-sync/dist/cli.js import-npc \
  --note vault/npcs/gravemire-stalker.md --live live.json   # all checks pass
npm run selftest                                            # NPC leg passes
```

…followed by the M6 manual checklist on the live sheet. When those pass, an
NPC written with Obsidian Fantasy Statblocks imports into Foundry and works.

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
