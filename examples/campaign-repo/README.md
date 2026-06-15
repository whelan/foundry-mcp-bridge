# Using the Foundry MCP bridge from a campaign repo

Copy these files into the root of the repo that holds your campaign notes, so
Claude Code (or any MCP client) running there can drive your live Foundry world.

```
your-campaign-repo/
├── .mcp.json                                  ← copy from here, edit the path/token
└── .claude/
    ├── settings.json                          ← auto-enables the server + tools
    └── skills/import-campaign-to-foundry/
        └── SKILL.md                           ← teaches Claude to import notes
```

## Steps

1. **Clone + build the bridge** somewhere on your machine (once):
   ```bash
   git clone <foundry-mcp-bridge> && cd foundry-mcp-bridge && npm install && npm run build
   ```
2. **Copy** this folder's files into your campaign repo (see tree above).
3. **Edit `.mcp.json`**: replace `/ABSOLUTE/PATH/TO/foundry-mcp-bridge` with the
   real path, and set `RELAY_TOKEN` (or delete it for a tokenless local relay).
   The launcher resolves its own paths, so an absolute path works from any cwd.
4. **Start Foundry** with a GM logged in, the `foundry-mcp-bridge` module enabled,
   and its Module Settings pointing at the **same** `RELAY_URL` + token.
5. **Open Claude Code** in your campaign repo. The MCP server starts on demand
   (it auto-builds on first run) and *hosts the relay* the module connects to.
6. Ask, e.g. *"import the NPCs in `npcs/` into Foundry"* — the
   `import-campaign-to-foundry` skill takes over.

## Notes

- The MCP server **is** the relay hub; the Foundry module dials out to it. One
  process, started by your MCP client over stdio.
- `delete_*` tools are intentionally **not** in the auto-allow list — deletes are
  terminal, so they'll prompt for confirmation.
- See the bridge's `docs/setup-foundry-forge.md` for local vs. The Forge specifics
  (tokens, URLs, the relay).
