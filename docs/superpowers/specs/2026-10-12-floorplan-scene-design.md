# Floorplan scene: one call from layout to playable scene

Status: draft for review, 2026-10-12.

## Goal

One request produces a complete Foundry scene for a building: a top-down floorplan painted by
Codex and saved as webp, with walls, doors, windows and lights set up so the picture and the
Foundry geometry line up. Doors animate, torches and fireplaces flicker.

Today the same result takes about five separate tool calls (generate, create_scene, add_walls,
add_lights, plus manual create_embedded for windows), the wall coordinates are placed by eye
against a picture that was never told where the walls are, the output is PNG, and the bridge
cannot express windows, door animation or light animation.

## Scope

In: square grids, axis-aligned rectangular rooms, doors, windows, wall-mounted and free
lights, furnishing names for the painter, webp output, an alignment preview.

Out (YAGNI): hex grids, diagonal or curved walls, multiple floors/levels, roofs, tokens,
automatic furniture collision, reading walls back from a picture.

## Verified against Foundry 14.368 / dnd5e 6.0.5 (live Test-mcp world)

- Wall fields: `c, levels, light, move, sight, sound, dir, door, ds, doorSound, threshold, animation, flags`.
- `animation` fields: `type, direction, double, flip, duration, strength, texture`.
  Types: `swing, slide, swivel, ascend, descend`.
- Sense types: `NONE 0, LIMITED 10, NORMAL 20, PROXIMITY 30, DISTANCE 40`.
  A window is modelled as `move` NORMAL with `sight` and `light` NONE (no threshold).
- Door states: `CLOSED 0, OPEN 1, LOCKED 2`.
- Light animations include `torch` and `flame`.
- `codex exec -i <file>` attaches an image to the prompt; `gen-image.mjs` already converts to
  webp when the output name ends in `.webp`.

## Input spec

Coordinates are grid cells; (0,0) is the top-left cell of the house footprint. The tool adds
the margin.

```
floorplan {
  name, style,                       // style: "timber cottage", "stone manor" ...
  cols, rows, feetPerCell = 5,
  rooms:    [{ id, x, y, w, h, name, floor, furnishings: [string] }],
  openings: [{ room, side: n|e|s|w, at, width = 1, kind: door|window|secretDoor,
               animation?, double?, flip?, locked?, open? }]  // exteriority is derived from the rooms,
  lights:   [{ at: [col, row],  // a cell; the light sits at its centre
               source: torch|fireplace|candle|lantern|daylight,
               bright?, dim?, color?, animation? }],
  codex: boolean = true, seed?
}
```

Validation rejects: overlapping rooms, rooms outside `cols x rows`, an opening whose `at` and
`width` fall outside its wall, an opening on an edge that is neither shared nor exterior, two
openings overlapping, a house with no exterior door. `kind: window` on an interior edge is
allowed (a see-through partition) but warned.

## Pipeline

1. **Geometry** (pure, `packages/shared/src/floorplan.ts`). From the rooms derive the set of unit
   edges, merge the shared ones, mark the exterior ones, cut the openings, then merge collinear
   runs into wall segments. Output: walls (with `door`, `animation`, `ds`, `threshold`), lights
   with presets, and per-room rectangles.
2. **Guide image** (pure, `renderGuide`). A flat blueprint PNG at 100 px per cell: room fills,
   wall lines, openings left open, and the outside margin filled. Rendered with a dependency-free
   PNG writer (the live test already has one in `scripts/lib/bridge-live/png.mjs`; the bridge needs
   its own copy in shared).
3. **Painting.** If `codex` is true, run the existing image job with the guide attached
   (`codex exec -i`). Prompt: paint a top-down floorplan exactly over the guide, same walls and
   openings, fill rooms with the listed furnishings, no grid, no text, no characters. Output
   `.webp`. If `codex` is false, convert the guide itself and use it as the map.
4. **Scene.** Upload the webp, create the scene at exactly `cols x rows` cells with the bridge's
   existing padding rule (the live test already asserts that the scene origin equals the
   padding Foundry applies).
5. **Embedded documents.** One `create_embedded` batch for walls, one for lights.
6. **Preview.** Return a PNG of the walls and lights drawn over the webp, so alignment is checked
   by eye before play. Undo is by `requestId` (existing change log), which removes scene,
   walls and lights in one go.

All of this runs as one MCP call that returns a `jobId` when Codex is slow (existing
`check_image_job` flow), then finishes steps 4 to 6.

## Door and window defaults

- Door: `door: DOOR`, `ds: CLOSED`, `animation: { type: swing, direction: 1, double: false,
  flip: false, duration: 800, strength: 1 }`. `animation` per opening overrides `type`,
  `double`, `flip`. `slide` and `swivel` are valid for sheds and gates.
- Locked: `ds: LOCKED`. Secret door: `door: SECRET`.
- Window: a see-through wall: `move` = `NORMAL`, `sight` and `light` = `NONE`, no threshold. The
  painter is told to draw glass in those spots.

## Light presets

| source | animation | bright/dim (ft) | colour |
|---|---|---|---|
| torch | `torch` | 20/40 | `#ff9d4a` |
| fireplace | `flame` | 15/30 | `#ff7a2e` |
| candle | `torch` (low intensity) | 5/15 | `#ffc36b` |
| lantern | none | 15/30 | `#ffd9a0` |
| daylight | none | 0/10 at a window | `#cfe0ff` |

Any field can be overridden per light.

## Changes in the bridge

- `shared/scene-builders.ts`: `WallKind` gains `window`; `buildWallFromGrid` accepts door options
  (`animation, state, locked, doorSound`) and window threshold; sense constants gain
  `PROXIMITY` and `DISTANCE`.
- `mcp-server/scene-tools.ts`: `add_walls` and `add_lights` expose the new fields.
- `shared/floorplan.ts` (new): spec schema, validation, geometry, guide renderer, overlay renderer.
- `mcp-server/floorplan-tools.ts` (new): `build_floorplan_scene`, composed from existing
  upload, `create_scene`, `create_embedded` and image-job code.
- Image jobs accept an optional guide image and a `.webp` output name.
- Docs and the live test plan.

## Testing

- Unit tests for geometry: single room, two rooms sharing a wall, door on a shared edge, window
  on an exterior edge, merged collinear runs, every validation error.
- Mock-Foundry integration test for the whole tool with a fake Codex (exists in the live test:
  `fake-codex.mjs`).
- Live test group "Floorplan": build a 3-room house on the Test-mcp world, then read the scene back
  and assert wall count, door animation, window thresholds and light animations; clean up.
- Manual: look at the overlay preview and open the scene in Foundry.

## Risks

- Codex may drift a few pixels from the guide. Walls always come from the spec, never from the
  picture. Mitigations: the guide attachment, the overlay preview, a rerun with a new `seed`, and
  `codex: false`.
- Codex may refuse or ignore the attached image. The live test with the real Codex is the first
  thing to run during implementation; if it ignores the guide, fall back to prompt-only with the
  room layout described in words and rely on the preview.
- Foundry door `animation` and window threshold shapes are v14 only. On v13 the tool returns
  `UNSUPPORTED` for animated doors and windows instead of writing fields Foundry would drop.
