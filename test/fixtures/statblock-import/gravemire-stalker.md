# Gravemire Stalker

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
    desc: "Constitution Saving Throw: DC 12, each creature that starts its turn within 5 feet of the stalker. Failure: The creature is poisoned until the start of its next turn. Success: The creature is unaffected."
actions:
  - name: Multiattack
    desc: "The stalker makes two Claw attacks."
  - name: Claw
    desc: "Melee Attack Roll: +5, reach 5 ft. Hit: 8 (1d10 + 3) Slashing damage plus 3 (1d6) Necrotic damage."
  - name: Grave Breath (Recharge 5-6)
    desc: "Constitution Saving Throw: DC 12, each creature in a 15-foot cone. Failure: 14 (4d6) Poison damage. Success: Half damage."
reactions:
  - name: Grasp of the Mire
    desc: "When a creature within 5 feet of the stalker moves away, the stalker makes one Claw attack against it."
```

A restless thing born of the swamp's grudge — it lurks in the reeds until prey draws close enough for the mire to claim.
