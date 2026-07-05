# D&D 5e SRD Fixtures

This directory contains fixtures for the D&D 5e System Reference Document (SRD), used in testing the statblock-sync module.

## License

Fixtures sourced from the official **D&D 5e SRD** are licensed under **CC-BY-4.0**. See the [Creative Commons Attribution 4.0 International License](https://creativecommons.org/licenses/by/4.0/) for details. Fixtures marked `"source": "homebrew"` (e.g. `actors24/gravemire-stalker.json`) are original test content created for this repo and are not SRD material.

**Attribution:** SRD content is the property of Wizards of the Coast and is used here under CC-BY-4.0.

## Directory Structure

- `actors24/` — D&D 5e 2024 rules NPC actors (from the official dnd5e system compendium)
- `actors/` — D&D 5e 2014 rules NPC actors (legacy, used as fallback)
- `monsterfeatures24/` — 2024 rules monster features (traits, abilities, actions)
- `monsterfeatures/` — 2014 rules monster features (legacy)

## Format

Each fixture is a JSON file named `{id}.json` containing:

```json
{
  "id": "compendium-id",
  "name": "Feature Name",
  "type": "Actor" | "Item",
  "version": "2024" | "2014",
  "source": "srd" | "xge" | etc,
  "data": { ... }
}
```

The `data` field contains the full dnd5e document structure (system, type, items, effects, etc.).

## How to Load

```typescript
import { loadFixture, listFixtures } from "./loader.js";

// Load a specific fixture
const actor = loadFixture("Actor", "gravemire-stalker");

// List all available fixtures
const allActors = listFixtures("Actor");
```

## Adding New Fixtures

To add a new fixture:

1. Export the document from dnd5e foundry as JSON
2. Create `{id}.json` in the appropriate directory (`actors24/`, `monsterfeatures24/`, etc.)
3. Ensure it has the required fields (`id`, `name`, `type`, `version`, `data`)
4. Document the source (SRD, XGE, etc.) in a comment

## Testing Note

These fixtures are deterministic and enable tests to run without external API calls or live Foundry access. They are not meant to be a complete SRD dump, but a curated set of representative documents for testing the import/sync pipeline.
