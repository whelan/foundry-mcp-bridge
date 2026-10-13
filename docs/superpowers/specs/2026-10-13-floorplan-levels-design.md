# Floorplan scene, part 2: several floors, stairs and a roof

Status: draft for review, 2026-10-13. Builds on `2026-10-12-floorplan-scene-design.md` (the
single-floor tool, PR #20).

## Goal

`build_floorplan_scene` can build a house with two (or more) floors in one scene:

- Each floor is its own Foundry 14 **Level** with its own painting, walls, doors, windows and lights.
- A **staircase** joins two floors. Stepping onto it asks the player whether to go up or down, then
  moves the token to the other level (Foundry's own `changeLevel` region behavior).
- A **roof** covers the house. Seen from outside the roof is solid and the interior is hidden, except what a
  token can see through windows and doors. Walking in makes the roof fade and shows the interior.

No module is needed: all of this is core Foundry 14.

## Scope

In: 1 to 4 floors, stairs between adjacent floors, one roof for the whole house, per-floor painting and
alignment preview, the existing single-floor input unchanged in meaning.

Out (YAGNI): basements and underground levels, spiral stairs, ladders, trapdoors, elevators, a roof per
wing or a sloped-roof model, interior fog of war authoring, hex grids, token placement on the new levels.

## Verified against Foundry 14.368 (live spike in Test-mcp, then deleted)

- A new Scene always has one Level, id `defaultLevel0000`, elevation 0 to 20. Scene.create does not accept
  more levels, so extra levels are added with `createEmbeddedDocuments("Level")` and the default level is
  renamed and re-ranged with `update`.
- `Level`: `name, elevation{bottom,top}, background{src,...}, foreground{src,...}, visibility{levels}, sort`.
  The picture of a floor is `level.background.src` (see `ensureSceneBackground`).
- `Wall`, `AmbientLight`, `Tile`, `Region` all have `levels` (a set of level ids); empty means every level.
  A wall with `levels:[upperId]` was created and read back.
- **Roof**: a `Tile` with `occlusion.modes [FADE 1, VISION 8]`. VISION is documented in Foundry for "rooves
  on buildings where players could see through a window or door, viewing only a portion of what is obscured by
  the roof". FADE fades the whole roof while a token is under it. A tile with `levels` and
  `occlusion.modes:[1,8]` was created and read back.
- **Stairs**: a `Region` with `levels:[lower, upper]`, `elevation{bottom,top}` spanning both, and a behavior
  `{type:"changeLevel", system:{movementActions:["walk"]}}`. Created and read back. Foundry shows its own
  confirmation dialog and moves the token (`change-level.mjs`).

## Input

`floors` is new. Without it the top-level `rooms`, `openings` and `lights` are floor 1 and nothing changes.
Giving both is a validation error.

```ts
floors?: Array<{                 // 1 to 4, index 0 is the ground floor
  name: string;                  // "Ground floor", "Upstairs"
  rooms: Room[]; openings?: Opening[]; lights?: FloorplanLight[];
}>
stairs?: Array<{
  at: [col, row];                // top-left cell of the stair footprint
  dir: "n"|"e"|"s"|"w";          // the direction you walk to go UP
  length?: number;               // cells along dir, default 3
  width?: number;                // cells across, default 1
  from?: number;                 // lower floor index, default 0; it joins `from` and `from + 1`
}>
roof?: boolean                   // default true
roofStyle?: string               // painter hint, default "thatched roof"
```

Room ids are unique within a floor; openings and lights refer to rooms of their own floor.

### Validation (all return readable errors, nothing is created)

- Every existing single-floor rule, per floor. The "needs an exterior door" rule applies to floor 0 only.
- Every room of floor n+1 lies inside the union of the rooms of floor n (a floor cannot overhang).
- A stair footprint lies inside a single room on both floors it joins, and its top cell on the upper
  floor is not on a wall. `from + 1` must exist.
- Two stairs on one floor do not overlap. A stair does not cover a door or window edge.
- A floor above floor 0 that has no stair leading to it is an error ("floor 1 is unreachable").

## Scene model

For floors f = 0..n-1 the floor height is 10 (scene distance units):

| Thing | Value |
|---|---|
| Level f | `name`, `elevation {bottom: 10f, top: 10f+10}`, `sort f`, `background.src` = painting of floor f |
| Level 0 | the existing `defaultLevel0000`, renamed and re-ranged |
| Walls, lights of floor f | `levels:[levelId f]` |
| Stair | one Region, rectangle in pixels, `levels:[level from, level from+1]`, `elevation {bottom: 10*from, top: 10*(from+2)}`, behavior `changeLevel` (walk) |
| Roof | one Tile at `x 0, y 0`, the size of the scene, `elevation = 10n` (just above the top level), `levels:` all levels, `occlusion.modes [1, 8]`, `occlusion.alpha 0` |

Single-floor houses use the same path with one level and, by default, a roof.

## Pictures

One painting per floor plus one for the roof, all sized `cols*px` by `rows*px`.

- **Floor guide**: the existing guide (walls, door and window bars) plus the stairs drawn as a distinct
  colour with arrows on both floors. The overlay and the alignment preview are made per floor.
- **Floor prompt**: lists that floor's rooms and furnishings and says what the stair is: a staircase leading up
  on the lower floor, the top of a staircase with a balustrade on the upper floor.
- **Roof guide**: the footprint (union of all rooms of all floors, plus a 0.4 cell eave) in white on black.
  The roof prompt asks for a top-down `roofStyle` covering the white shape, ridge lines, a chimney over each
  fireplace, black outside. No walls, no interior.
- **Roof mask (ImageMagick)**: after Codex, the roof picture is masked to the footprint polygon so the area
  outside the house is transparent. This makes the transparency exact and does not depend on the model.
  Without ImageMagick the roof is skipped with a warning (the rest still builds).
- `codex:false` uses the guides as the pictures (the roof guide is masked the same way).

A 2-floor house with a roof is 3 Codex runs. They run one after another inside one image job, so there is one
`jobId` to poll. The job fails as a whole if one image fails; images already made stay on disk.

## Tool changes

- `add_walls` and `add_lights` get an optional `levels: string[]` that is written to each document.
- `ImageRequest` gets an optional `parts: ImageRequest[]`; the job runs them in order and `FloorplanApply`
  records which file is which floor and which is the roof.
- `finishFloorplan` is rewritten around floors: fit and upload every picture, create the scene, rename the
  default level, add levels, set every background, then walls and lights per level, the stair regions, and the
  roof tile. Each step uses the existing reliable pipeline (dry run, read-back, undo by request id).
- Result: `sceneId, levels[{id,name}], stairs, roof: {tileId, src} | null, previews[], walls, lights, warnings`.
- Foundry older than 14 is refused up front for the whole tool (already true).

## Testing

- `floorplan.test.ts`: floors normalisation, every validation rule above, per-floor geometry and light
  placement, backward compatibility with the single-floor input.
- `floorplan-render.test.ts`: stairs in the guide, the roof guide footprint, the eave.
- `finishFloorplan` tests on the mock: levels created with the right elevations, walls and lights carry the
  right `levels`, stair region and roof tile fields, `ensureSceneBackground` for level 0 and the others.
- The mock Foundry gains `Level`, `Region` and `Tile` documents and the default level on scene create.
- Live suite (curse-of-strahd, group 9): build a 2-floor house with the fake Codex and assert levels, stair
  behavior, roof tile modes and the level of every wall and light; clean up.
- By hand in Test-mcp: view the house from outside (roof solid, interior visible only through windows), walk
  a token in (roof fades), use the stairs (prompt, token on the other level), look through an upper window.

## Risks

- The roof reads as part of the picture only if Codex follows the footprint guide; the mask guarantees the
  outline, not the painting quality. Mitigation: `roofStyle`, `seed`, and the preview image.
- `VISION` occlusion needs token vision on in the scene; the tool sets `tokenVision: true`.
- Level visibility: a viewer on level f sees only that level (and the roof). Seeing the floor below through a
  stairwell is not modelled.
- Three images per house cost time. A single-floor house stays at 1 image plus 1 for the roof, and
  `roof:false` keeps it at 1.

## Thornwick Cottage (the worked example)

Rebuilt as two floors on the same 18x12 footprint: the great hall, kitchen and a pantry below with the
staircase in the hall; the bedroom, a study and a landing above, same stair position. Four exterior
and interior doors, windows on both floors, fireplaces and torches per floor, a thatched roof.
