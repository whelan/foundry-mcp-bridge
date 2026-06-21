# Export a Foundry world to an Obsidian vault

`foundry-sync export` reads a **downloaded Foundry world folder** (the on-disk
LevelDB stores, v11+) and writes campaign-sync-convention markdown notes plus a
`foundry-sync.json` manifest into an Obsidian vault. The output round-trips: an
immediate `foundry-sync plan` against the same world reports everything
`unchanged`, so you can edit in Obsidian and push changes back with the normal
sync flow.

## What it converts

| Source (world DB) | → Notes | Front-matter |
|-------------------|---------|--------------|
| Actors | `generated/npcs/<slug>.md` | `id, name, type, img, cr, hp, hpMax`; body = biography |
| JournalEntry (+ pages) | `generated/journals/<slug>.md` | `id, name`; body = pages (HTML→markdown) |
| Forien's Quest Log quests | `generated/quests/<slug>.md` | `id, name, status, tasks, giver, parent`; body = description |
| Scenes | `generated/scenes/<slug>.md` | `id, name, width, height, gridSize, background` |

(A JournalEntry carrying `flags["forien-quest-log"].json` is routed to
`generated/quests/`, not `generated/journals/`.)

## Usage

```bash
# one-time: the reader needs the LevelDB binding Foundry uses
npm i classic-level   # in the bridge repo (it's an optionalDependency)

node <bridge>/packages/campaign-sync/dist/cli.js export \
  --world /path/to/foundrydata/Data/worlds/curse-of-strahd \
  --out   /path/to/your-obsidian-vault \
  [--manifest /path/to/your-obsidian-vault/foundry-sync.json] [--force]
```

`--world` points at a world folder (the one containing `world.json` and a `data/`
directory of LevelDB stores). The world must **not** be open in Foundry while you
read it (LevelDB takes an exclusive lock).

**Re-exporting:** if the vault already has notes under `generated/{journals,npcs,
scenes,quests}`, export refuses (so it never mixes a fresh world with stale notes
that would plan as spurious creates). Re-run with `--force` to clear those four
exporter-owned directories first — this deletes generated notes no longer in the
world but leaves the rest of your vault untouched.

## Notes

- **HTML → Markdown** is intentionally minimal (paragraphs, headings, bold/italic,
  lists, links, common entities). Unknown tags are stripped. It aims for readable
  notes, not byte-perfect fidelity — the manifest tracks the *rendered* content, so
  round-trip sync stays consistent regardless.
- **Assets aren't copied.** Scene/token paths are recorded as-is in front-matter;
  the existing import/sync flow handles asset upload when pushing back.
- The converter (`buildVault`) is pure and unit-tested; only the LevelDB read
  (`leveldb.ts`) touches the disk and is not run in CI.
