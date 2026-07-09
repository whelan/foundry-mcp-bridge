# Codex image-generation backend for gen-image.mjs

**Date:** 2026-07-08
**Status:** ready for implementation (design by Claude Code; review before handing to a cloud agent)
**Implements on top of:** `scripts/gen-image.mjs` (backends `cli`, `a1111`) and
`.claude/skills/generate-and-upload-image/SKILL.md`, both on `main`.

## Problem

`codex exec` can generate images (OpenAI image tool via the `imagegen` skill),
but it saves them to its own cache and **cannot copy them into the workspace**:
its shell tool fails with `unsupported call: exec_command`, so a prompt like
"generate X and save it as ./images/shiba.png" ends with the file stranded at

```
~/.codex/generated_images/<session-id>/<call-id>.png
```

and the user moving it by hand. Observed with OpenAI Codex v0.143.0
(model gpt-5.5, sandbox `workspace-write`).

Additionally, where generated images belong differs per project (this repo has
`images/`; a campaign repo has its own asset layout), and today the script
always requires an explicit `--out` path.

## Solution overview

1. Add a third backend, **`codex`**, to `scripts/gen-image.mjs`. It drives
   `codex exec` non-interactively, tells the model **not** to attempt any
   copy, locates the generated file deterministically via the session id, and
   moves it to the destination itself.
2. Add **per-project output-directory resolution** so `--out` can be replaced
   by a short `--name`, with the directory coming from project config.
3. Update the `generate-and-upload-image` skill to document `codex` as the
   zero-setup backend (no local diffusion stack required).

No new script, no new dependencies (Node stdlib only), no change to the
upload half of the pipeline (`upload_asset` MCP tool + sidecar).

## Verified codex CLI facts (v0.143.0 — re-verify if version differs)

- `codex exec --json` emits JSONL on stdout; the **first** event is
  `{"type":"thread.started","thread_id":"<uuid>"}` and that `thread_id` is
  exactly the directory name under `generated_images/`:
  `$CODEX_HOME/generated_images/<thread_id>/call_*.png`
  (`CODEX_HOME` defaults to `~/.codex`).
- Without `--json`, the banner contains a `session id: <uuid>` line — usable
  as a fallback regex `/session id:\s*([0-9a-f-]{36})/`.
- `codex exec` reads stdin when it is piped ("Reading additional input from
  stdin..."), so the spawn **must** redirect stdin from `/dev/null` (or
  `stdio: ["ignore", ...]`) or the run can hang/absorb garbage.
- Useful flags: `-s read-only` (we don't want it writing to the workspace at
  all), `--skip-git-repo-check`, `-m <model>`, `-C <dir>`.
- Do **not** use `--ephemeral`: it disables session persistence and it is
  unverified whether generated images still land on disk.

## Design

### 1. `backendCodex(args)` in `scripts/gen-image.mjs`

Follows the shape of the existing `backendCli` / `backendA1111` functions.

**Prompt sent to codex** (wrap the user prompt; this avoids the doomed
copy attempts that waste turns and produce ERROR spam):

```
Use the image generation tool to generate exactly one image:

<user prompt>

Do not attempt to save, copy, move, or verify the file — only generate it.
```

Size hints: if `--width`/`--height` are given, append "Target size:
{width}x{height}." to the prompt (codex's image tool takes no explicit size
flags). `--steps` / `--negative` are diffusion-specific and ignored by this
backend (note this in the usage header).

**Invocation** (via `spawn`, no shell — the prompt is a single argv entry, so
no quoting/injection concerns):

```
codex exec --json -s read-only --skip-git-repo-check [-m <model>] <wrapped prompt>
```

- stdin: `"ignore"`; stdout: captured line-by-line; stderr: passed through to
  the script's stderr (progress visibility).
- Model: `--codex-model` CLI arg → `codex.model` in project config (see §2) →
  `IMAGE_GEN_CODEX_MODEL` env → omit `-m` (codex default).
- Timeout: kill the child and fail after `IMAGE_GEN_TIMEOUT_MS` (default
  300 000 ms).

**Locating the output:**

1. Parse each stdout line as JSON; take `thread_id` from the first
   `thread.started` event. Fallback: session-id regex over all captured
   output. If neither matches, fail with the last ~20 lines of output.
2. After the child exits 0, list
   `${CODEX_HOME ?? os.homedir() + "/.codex"}/generated_images/<id>/`
   for image files (`.png` `.jpg` `.jpeg` `.webp`).
   - none → fail: "codex completed but produced no image" + output tail
     (typically means the model answered in text or refused).
   - multiple → pick the newest by mtime, warn on stderr listing the rest.
3. **Move** the file to the resolved destination with a cross-device-safe
   move: try `rename()`, on `EXDEV` fall back to copy + unlink. (This is the
   common case here: `~/.codex` on the system volume, projects on
   `/Volumes/...`.) Create the destination directory with
   `mkdir { recursive: true }` first.

The existing tail of `main()` (read bytes, JSON summary, `.b64` sidecar)
runs unchanged, so the Foundry-upload flow works for this backend for free.

### 2. Per-project output resolution (all backends)

Today `--out` is required. New resolution, in `main()` before dispatch:

- `--out <path>` given → use verbatim (fully backwards compatible).
- else `--name <filename>` given → destination is `<outputDir>/<filename>`
  where `outputDir` is the first of:
  1. `--out-dir <dir>` CLI arg
  2. `IMAGE_GEN_OUT_DIR` env var
  3. `outputDir` from `.imagegen.json` in the current working directory
  4. `images/` under the current working directory (created if missing)
- else → fail: "missing --out or --name".

`.imagegen.json` (project root, committed per project — this is the
"different from project to project" knob):

```json
{
  "outputDir": "images",
  "codex": { "model": "gpt-5.5" }
}
```

Unknown keys are ignored. A missing or unparsable file is treated as absent
(warn on stderr if present but invalid, don't fail). This repo gets a
`.imagegen.json` with `outputDir: "images"` as part of this change.

### 3. Skill update

`.claude/skills/generate-and-upload-image/SKILL.md`:

- Backend list gains `codex` — "OpenAI Codex CLI (`codex` on PATH, logged
  in); zero local-model setup; the wrapper locates the file in codex's cache
  and moves it into place because codex's own sandbox cannot write to the
  workspace."
- The description frontmatter gains codex phrasing so the skill triggers on
  "generate an image with codex".
- Step 2's example shows `--backend codex --name shiba.png` and mentions
  `.imagegen.json`; note that `--steps/--negative` don't apply to codex.
- New short "Generate into the project" note: when the user wants the image
  in the repo (not uploaded to Foundry), stop after step 2 — the file is
  already at its final path; report the path.

### Error handling summary

| Failure | Behaviour |
| --- | --- |
| `codex` not on PATH | fail: "backend 'codex' needs the OpenAI Codex CLI (`codex`) on PATH" |
| child exits non-zero | fail with exit code + output tail |
| timeout | kill child, fail naming `IMAGE_GEN_TIMEOUT_MS` |
| no session id in output | fail with output tail (format drift — mention `--json`) |
| session dir missing/empty | fail: completed but no image (refusal/text answer) + tail |
| `rename` EXDEV | transparent copy+unlink fallback |
| invalid `.imagegen.json` | warn, behave as if absent |

### Testing (mock-first, per repo convention)

Extract the decision logic into pure, exported helpers so vitest covers it
without a codex install:

- `parseCodexSessionId(lines: string[]): string | null` — JSONL first,
  regex fallback, garbage tolerated.
- `pickGeneratedImage(entries: {name, mtimeMs}[]): {chosen, extras}` —
  extension filter + newest-wins.
- `resolveOutPath(args, config, env, cwd)` — the §2 precedence table.
- `buildCodexPrompt(args)` — wrapped prompt incl. size hint.

Add `test/unit/gen-image.test.ts` (or extend the existing test layout) for
these. The spawn/move plumbing stays thin and untested-in-CI, mirroring how
`foundry-runtime.ts` is handled. A manual smoke command goes in the skill:

```bash
node scripts/gen-image.mjs --backend codex \
  --prompt "a shiba inu wearing sunglasses" --name shiba.png
```

Gate: `verify-bridge` skill (build → typecheck → test) — note
`tsconfig.test.json` must type-check any new test file.

## Alternatives considered

- **Standalone wrapper script/skill outside this repo** — rejected:
  duplicates the summary/sidecar/upload machinery that already exists here;
  per-project variance is handled by `.imagegen.json`, not by forking the
  script. If it later needs to be global, the script is dependency-free and
  can be lifted as-is.
- **mtime scan of `generated_images/` (before/after snapshot) as primary
  mechanism** — rejected as primary: racy with concurrent codex sessions;
  the session id is deterministic. Kept only as the regex fallback's basis.
- **Letting codex copy the file itself (workspace-write + `--add-dir`)** —
  rejected: its exec tool is what's broken (`unsupported call:
  exec_command`), and even when fixed, `read-only` + wrapper-move is fewer
  moving parts and keeps the sandbox tight.

## Implementation checklist

1. `scripts/gen-image.mjs`: add `backendCodex`, the four pure helpers,
   `--name/--out-dir/--codex-model` args, `.imagegen.json` loading, and the
   §2 resolution; update the usage header comment (backends line, new flags,
   codex ignoring `--steps/--negative`).
2. Add `.imagegen.json` (`outputDir: "images"`) at repo root.
3. Unit tests for the four helpers.
4. Update `.claude/skills/generate-and-upload-image/SKILL.md` (frontmatter
   description + backend docs + project-destination note).
5. Run the verify-bridge gate; smoke-test live with the command above if a
   codex login is available.
