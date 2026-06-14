# Projekt- & testplan: `foundry-mcp-bridge` (nyt modul-repo)

Blueprint for det nye, selvstændige projekt der implementerer live AI→Foundry-integrationen fra
`foundry-live-api-plan.md`. Skrevet her (i campaign-repoet) som varigt referencepunkt; selve koden
flytter til sit eget GitHub-repo (se §1).

> **Designkrav fra ejeren:**
> 1. Skal kunne **deles** — andre skal kunne installere det. **Ingen hardcodede connection-strenge,
>    nøgler eller stier** i delt kode. Tydelig dokumentation af hvad der sættes hvor.
> 2. Under **udvikling** må der gerne bruges hardcodede/lokale værdier — men **isoleret** fra delt kode
>    (gitignored dev-config), så de aldrig havner i et release.
> 3. Skal kunne udvikles og testes så **autonomt som muligt** (mock-first), med rigtige Foundry/Forge-
>    tests via tunnel/secrets når de er sat op.

---

## 1. Repo & arkitektur

**Nyt repo:** `foundry-mcp-bridge` (forslag). Monorepo, fordi modul og server deler typer/skema:

```
foundry-mcp-bridge/
├─ packages/
│  ├─ foundry-module/        # Foundry V14-modulet (kører i GM-klienten)
│  │  ├─ module.json         # manifest (compatibility v13..v14)
│  │  ├─ src/                # init/ready, WebSocket-klient, kommando-dispatch, doc-API-kald
│  │  └─ settings.js         # game.settings.register (relay-URL, token, auto/confirm)
│  ├─ mcp-server/            # MCP-server (Claude taler hertil)
│  │  ├─ src/tools/          # create_document, create_scene, create_quest, update_*, find_*
│  │  ├─ src/relay/          # WebSocket-relay som modulet forbinder til
│  │  └─ src/config.ts       # AL konfiguration læses HER (env) — ét sted
│  └─ shared/                # delte zod-skemaer + doc-byggere (genbrugt fra import-scenes.js)
├─ test/
│  ├─ unit/                  # mod mock Foundry-API
│  ├─ integration/           # mod mock-relay/-Foundry (in-container, autonomt)
│  ├─ contract/              # golden payloads vs. V14-skema
│  └─ e2e/                   # mod RIGTIG Foundry (tunnel) + Forge (smoke)
├─ .env.example              # dokumenterer ALLE variable (committet)
├─ .env                      # rigtige værdier (gitignored)
├─ dev.config.example.json   # dev-only hardcodede værdier (skabelon, committet)
├─ dev.config.json           # dev-only rigtige værdier (gitignored)
└─ README.md                 # installations- & konfig-guide for andre brugere
```

**Forhold til `adambdooley/foundry-vtt-mcp`:** beslut i Fase 1 om vi **forker** den (MIT) som base for
`mcp-server` + `foundry-module` og tilføjer vores tre skrive-værktøjer, eller bygger rent. Uanset hvad
bevares strukturen ovenfor.

---

## 2. Konfiguration — "andre kan bruge det" (ingen hardcoding)

Tre konfig-lag, klart adskilt. **Intet hemmeligt eller miljøspecifikt i delt kode.**

| Lag | Hvad | Hvor | Committes? |
|-----|------|------|-----------|
| **Modul-indstillinger** | Relay-URL, delt token, auto-execute vs. bekræft | Foundry UI via `game.settings.register` | Nej (ligger i brugerens verden) |
| **Server-env** | Relay-port, MCP-transport, token, (valgfri) Forge-API-nøgle | `.env` (læses kun i `mcp-server/src/config.ts`) | Nej — `.env.example` ja |
| **Dev-override** | Hardcodede lokale værdier der letter udvikling | `dev.config.json` | **Nej** (gitignored); `*.example` ja |

**Regler i koden:**
- `config.ts` er **eneste** sted der læser `process.env` / `dev.config.json`. Resten af koden tager config
  som parameter (dependency injection) → ingen spredte `process.env`-kald, nemt at teste.
- **Ingen defaults der peger på en privat maskine.** Manglende påkrævet config → tydelig fejl:
  `"FOUNDRY_RELAY_TOKEN mangler — se README §Konfiguration"`. Aldrig en hardcoded fallback-URL.
- `dev.config.json` loades **kun** hvis `NODE_ENV=development` og filen findes; ellers ignoreres den helt.
  Så et release kan aldrig komme til at bruge dev-værdier.
- **README** dokumenterer hvert felt: navn, hvad det er, hvor man finder værdien (fx "token: vælg selv en
  tilfældig streng, sæt samme i modul-indstilling og `.env`"), og et fuldt eksempel.

`.env.example` (committet) bliver kontrakten:
```bash
# --- MCP-server ---
FOUNDRY_RELAY_PORT=3010           # port relay-serveren lytter på
FOUNDRY_RELAY_TOKEN=              # delt hemmelighed; SAMME værdi i modulets indstilling
MCP_TRANSPORT=stdio               # stdio (Claude Desktop) | sse
# --- Valgfrit: kun hvis serveren selv skal uploade til Forge uden en åben klient ---
FORGE_API_KEY=                    # fra forge-vtt.com → API Key Manager (ellers tom)
```

---

## 3. Test-strategi (autonom udvikling, mock-first)

Lagdelt, så jeg kan udvikle **uden indblanding** i containeren, og rigtige tests tilføjes ovenpå.
Hvert lag kan køres isoleret; CI kører Lag 0–3 (kræver ingen rigtig Foundry).

| Lag | Hvad testes | Afhænger af | Autonomt i container? |
|-----|-------------|-------------|------------------------|
| **0. Statisk** | lint, typecheck, format | intet | ✅ |
| **1. Unit** | værktøjs-logik, config, skema-validering, doc-byggere | **mock Foundry-API** (stub af `Actor.create` osv.) | ✅ |
| **2. Kontrakt** | byggede payloads matcher **Foundry V14-skema** (golden files) | genbrug `generated/`-skemaer + V14-skema-snapshot | ✅ |
| **3. Integration** | hele kæden MCP → relay → **mock-modul** → mock-Foundry | **mock-relay/-Foundry** (se §3.1) | ✅ |
| **4. E2E lokal** | mod **rigtig** lokal Foundry (V14 + dnd5e + FQL) | tunnel til din Foundry (§4) | ⚠️ kræver tunnel |
| **5. Forge smoke** | mod **rigtig** Forge-verden | Forge-login/secret (§4) | ⚠️ kræver secret |

### 3.1 Mock-Foundry (kernen i autonom test)
En lille fixture-server i `test/integration/mock-foundry.ts` der:
- Eksponerer en **WebSocket** der taler præcis samme kommandoprotokol som det rigtige modul forventer
  (samme JSON-kommandoer: `create_document`, `update_document`, `create_scene`, `create_quest`, …).
- Holder en **in-memory dokument-store** med Foundrys nøglekonventioner (`!actors!{id}` osv. — genbrug
  viden fra `import-scenes.js`), så `find`/`update`/read-back kan verificeres realistisk.
- Implementerer en **`FilePicker`-mock** med både `"data"`- og `"forgevtt"`-kilde, så asset-stien (§4 A4)
  kan testes uden rigtig Forge.
- Kan injiceres med fejl (afvis payload, timeout, drop) for at teste **pålideligheds-laget** (§11):
  validér→dry-run→skriv→verificér→retry→rollback.

Dermed kan **alt funktionelt** udvikles og regressions-testes autonomt; Lag 4–5 bekræfter kun at
mock'en matcher virkeligheden.

### 3.2 Golden/kontrakt-tests
Tag rigtige dokument-snapshots fra den eksisterende verden (`actors/npcs/*.json`, en udtrukket scene) som
**golden files**. Test at vores byggere/validering producerer/accepterer dem uændret. Fanger skema-drift
mod V14 tidligt og gratis.

### 3.3 CI (på det nye repo)
GitHub Actions: kør Lag 0–3 på hver push/PR. Ingen rigtig Foundry nødvendig → grøn CI uden secrets.
Lag 4–5 køres manuelt/nightly med secrets (hvis sat op).

---

## 4. Rigtig adgang under udvikling (dit valg: "giv mig rigtig adgang")

For at jeg kan køre Lag 4–5 fra containeren kræves to ting fra dig. **Sikkerhed først:** brug en
**dedikeret "AI-GM"-konto**, aldrig din hovedadgangskode; alle hemmeligheder som **session-secrets/env**,
aldrig i git.

**A. Lokal Foundry (Lag 4) — via tunnel:**
1. Start din lokale Foundry (V14, CoS-verden, med dnd5e + FQL + forge-vtt-modul aktivt).
2. Eksponér den med en tunnel, fx `cloudflared tunnel --url http://localhost:30000` eller `ngrok http 30000`.
3. Giv mig (som secrets): `FOUNDRY_E2E_URL` (tunnel-URL), `FOUNDRY_E2E_GM_USER`, `FOUNDRY_E2E_GM_PASSWORD`
   (den dedikerede AI-GM-bruger i verdenen).
4. **Tjek netværkspolitik:** containerens udgående adgang skal tillade tunnel-domænet. Hvis politikken
   blokerer, falder vi tilbage til at *du* kører Lag 4 lokalt via en tjekliste jeg laver.

**B. Forge (Lag 5):**
- Forge kræver login på `forge-vtt.com`. To muligheder:
  - **Headless Playwright** der logger ind som AI-GM-kontoen — kræver `FORGE_E2E_USER`/`FORGE_E2E_PASSWORD`
    som secrets (dedikeret konto!). Skrøbeligt mod Forge-UI-ændringer.
  - **Assets-only via API-nøgle:** `FORGE_API_KEY` (fra API Key Manager) lader serveren teste asset-upload
    direkte mod Assets Library uden fuld game-login. Dækker §4 A4, ikke fuld dokument-e2e.
- **Realistisk anbefaling:** automatisér Lag 5-asset-delen via `FORGE_API_KEY`; kør fuld Forge-dokument-
  e2e som en **manuel smoke-test** (tjekliste jeg leverer), da headless game-login mod Forge er ustabilt.

> Hvis tunnel/secrets ikke kan sættes op, mister vi **ingen funktionel dækning** — kun den sidste
> bekræftelse mod ægte servere, som så bliver din manuelle smoke-test. Udvikling fortsætter autonomt.

---

## 5. Implementerings-rækkefølge (når repo + adgang er klar)

1. **Scaffold** monorepo (§1) + config-lag (§2) + tom CI (Lag 0).
2. **shared/**: flyt `import-scenes.js`' doc-byggere hertil + zod-skemaer (kontrakt for offline & live).
3. **mock-foundry** (§3.1) + Lag 1–3 tests — *før* rigtig integration, så TDD er muligt.
4. **foundry-module** skelet: WebSocket-klient + `create_document` (simplest, genbruger NPC-skema).
5. **mcp-server** værktøjer: `create_document` → `create_scene` → `create_quest` (FQL) → `update_*`/`find_*`.
6. **Pålideligheds-lag** (§11) ind i hvert skrive-værktøj.
7. **Lag 4 e2e** mod tunnel-Foundry; ret mock'en hvor den afveg.
8. **Forge** (§4 B): asset-upload via `"forgevtt"` + `FORGE_API_KEY`; smoke-tjekliste til resten.
9. **README**: installations- & konfig-guide for andre brugere.

---

## 6. Setup-tjekliste til ejeren (de to ting der låser op nu)

- [ ] **Opret repo** `foundry-mcp-bridge` på GitHub (tomt). *Jeg kan oprette det for dig via GitHub-
      værktøjet, hvis du siger til* — ellers opret det selv.
- [ ] **Tilføj repoet til denne session** (web/app: tilføj repository til miljøet) så jeg kan pushe dertil.
- [ ] **(Til Lag 4)** Start lokal Foundry + tunnel; læg `FOUNDRY_E2E_URL/_USER/_PASSWORD` som secrets.
- [ ] **(Til Lag 5)** Opret dedikeret AI-GM-konto + `FORGE_API_KEY`; læg som secret.
- [ ] Bekræft at miljøets **netværkspolitik** tillader udgående til tunnel/Forge (ellers kører du Lag 4–5).
