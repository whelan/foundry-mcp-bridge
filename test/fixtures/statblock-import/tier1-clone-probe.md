# Tier1 Clone Probe

```statblock
name: Tier1 Clone Probe
size: Medium
type: aberration
alignment: Unaligned
ac: 10
ac_class: natural
hp: 10
hit_dice: 3d8
speed: 30 ft.
stats: [10, 10, 10, 10, 10, 10]
senses: passive Perception 10
languages: --
cr: 0
actions:
  - name: Slam
    desc: "Melee Attack Roll: +2, reach 5 ft. Hit: 3 (1d4 + 1) Bludgeoning damage."
```

A minimal probe statblock whose only purpose is to exact-name-match a
compendium stand-in in `scripts/selftest.mjs`'s mock relay, exercising the
Tier 1 (compendium-clone) import + refresh path (M6d). Its own mechanical
values are irrelevant — Tier 1 refresh always defers to the compendium, never
the note.
