# Reverse Engineering-plan: Live Foundry-API (MCP / REST-modul) + The Forge

**Mål:** En **fuld, autonom AI→Foundry-integration**. En AI-agent (Claude) skal kunne udføre **enhver**
kampagne-opgave i en **kørende** Foundry VTT V14-verden — oprette og opdatere actors, items, scener,
journaler, tiles, walls, lys, tokens, playlists, macros, roll tables, mapper, combats m.m. — automatisk,
verificerbart og uden manuel indgriben, og det skal virke når verdenen hostes på **The Forge**.

**Om "uden fejl":** absolut fejlfrihed kan ikke garanteres (Foundry kan afvise data, Forge kan time-oute,
en version kan bryde et skema). Målet er derfor **korrekthed-ved-konstruktion**: hver operation
**validerer før afsendelse**, kan køres som **dry-run**, og **læses tilbage og verificeres efter skrivning**,
med **auto-retry** og **rollback/backup** ved fejl. Systemet skal enten lykkes *verificerbart* eller fejle
*sikkert og rapporteret* — aldrig fejle stille. Se §11 (Pålideligheds-laget).

Dette dokument er en undersøgelses- og implementeringsplan, ikke en færdig implementering.
Alt der er markeret **[VERIFICÉR]** er en antagelse der skal bekræftes under reverse engineering,
før der bygges oven på det.

---

## 1. Udgangspunkt: hvad vi allerede har (og kan genbruge)

Repoet indeholder allerede en betydelig mængde reverse-engineeret Foundry-viden. Den skal **ikke**
smides væk — den er fundamentet for live-API'et.

| Aktiv | Hvor | Genbrug i live-API |
|-------|------|--------------------|
| Foundry V14 **dokumentskema** for Scene + embedded docs | `scripts/import-scenes.js` (`buildScene`, `buildLight`, `buildToken`, `buildNote`) | Samme JSON-payloads sendes til live-API'et i stedet for at blive skrevet til LevelDB |
| NPC/actor-skema | `CLAUDE.md` (NPC required fields), `actors/npcs/*.json` | Genbruges 1:1 som `Actor.create`-data |
| Navne→id-opslag mod verdenen | `import-scenes.js` (`loadWorldIndex`) | I live-API laves opslag via `game.actors.getName()` i stedet for LevelDB-iteration |
| LevelDB-nøglekonventioner | `!scenes!{id}`, `!scenes.tokens!{sceneId}.{tokenId}` | Bekræfter den interne datamodel; nyttig til validering/fallback |
| Idempotent upsert-mønster (skriv `_id` tilbage i spec) | `import-scenes.js` | Samme mønster i live-API: gem returnerede `_id` i `generated/**/*.json` |

**Centralt skift i arkitektur:**

```
NU (offline):   spec.json ──▶ classic-level ──▶ world/data/*  (Foundry SKAL være slukket, LOCK-tjek)
MÅL (live):     spec.json ──▶ MCP/REST ──▶ Foundry-klient-API ──▶ socket ──▶ server  (Foundry KØRER)
```

Den afgørende forskel: Foundrys persisteringslag (LevelDB) er det **forkerte** lag at ramme live.
Når Foundry kører, holder serveren databasen åben (deraf LOCK-tjekket i `leveldb.js`), og direkte
skrivning ville (a) konflikte med serverens egne skrivninger og (b) ikke udsende de socket-events
der opdaterer tilsluttede klienter. Live skal vi ind via Foundrys **dokument-API**, som håndterer
både persistering og realtids-broadcast.

---

## 2. Foundry VTT's interne arkitektur (det der skal reverse-engineeres)

Forståelse af lagene er forudsætningen for at vælge integrationspunkt.

```
┌─────────────────────────────────────────────────────────────┐
│ BROWSER-KLIENT (GM eller spiller)                            │
│  game.actors / game.scenes / game.journal  (WorldCollections)│
│  Document API:  Actor.create(), Scene.update(), doc.delete() │
│  Hooks:         Hooks.on("createActor", ...), preCreate...   │
│  socket (socket.io-client)  ◀── realtids-broadcast           │
└───────────────────────────────┬─────────────────────────────┘
                                 │  socket.io (WebSocket)
                                 │  event: "modifyDocument" / "manageDocument" [VERIFICÉR]
┌───────────────────────────────▼─────────────────────────────┐
│ NODE-SERVER (Foundry hovedproces — på The Forge: hostet)     │
│  Validerer mod DocumentSchema, persisterer til LevelDB,      │
│  broadcaster ændringen til alle tilsluttede klienter         │
│  HTTP: /join, /setup, /game, statiske assets  (IKKE et       │
│        generelt dokument-REST-API)                           │
└───────────────────────────────┬─────────────────────────────┘
                                 │
┌───────────────────────────────▼─────────────────────────────┐
│ DATA: world/data/{actors,scenes,journal,items,...} (LevelDB) │
│  ← det er DETTE lag de nuværende scripts rammer offline      │
└─────────────────────────────────────────────────────────────┘
```

**Nøgleindsigter der styrer planen:**

1. **Foundry har ikke et officielt generelt REST-API for dokumenter.** Serveren taler primært
   socket.io. Al CRUD initieres klient-side (`Document.createDocuments` → `SocketInterface.dispatch`
   → socket-event → server). Vi kan altså ikke bare `POST /api/actors`.
2. **Moduler kører klient-side i browseren.** Et Foundry-modul er som udgangspunkt browser-JavaScript;
   det kan ikke tilføje nye HTTP-routes til Node-serveren. Det betyder at "et modul der eksponerer
   REST" reelt bliver "et modul der åbner en **udgående** forbindelse til en ekstern relay/MCP-server
   og udfører kommandoer i klient-konteksten."
3. **For at skabe dokumenter skal man have en GM-klient-session** (enten en rigtig browser, eller en
   headless socket-klient der har autentificeret som GM).
4. **The Forge ændrer ikke Foundrys interne API** — den hoster bare standard-Foundry bag en
   proxy + eget login. Det betyder modul-tilgangen (udgående forbindelse fra klienten) virker uændret;
   det er kun den *headless/direkte* tilgang der støder på Forge's auth-lag.

---

## 3. To hovedtilgange + anbefaling

### Tilgang A — Foundry-modul som relay (ANBEFALET, især pga. The Forge)

Et lille Foundry-modul installeres i verdenen. Når en GM er logget ind, åbner modulet en **udgående
WebSocket** til vores egen relay/MCP-server. MCP-serveren sender kommandoer (`create_actor`,
`create_scene`, …); modulet udfører dem med det officielle klient-API (`Actor.create(data)`,
`Scene.create(data)`, `JournalEntry.create(data)`) og sender resultatet retur.

```
Claude / MCP-klient ──▶ MCP-server ──▶ WebSocket ──▶ Foundry-modul (i GM's browser) ──▶ game.*.create()
                          (vores)         (relay)        (klient-kontekst = fuld autoritet)
```

**Fordele**
- Bruger Foundrys **officielle, versionsstabile** dokument-API → ingen skrøbelig socket-protokol-parsing.
- Virker **uændret på The Forge** (udgående WebSocket fra klienten; ingen indgående porte kræves).
- Får automatisk validering, hooks, realtids-broadcast, `_id`-generering gratis.
- Fungerer som community-projekterne `foundryvtt-rest-api` / `foundry-mcp` (referencearkitektur, se §6).

**Ulemper**
- Kræver at en GM-klient er **åben** (en browser-fane, evt. en dedikeret headless Chrome/relay-fane).
- Modulet skal vedligeholdes pr. Foundry-major-version (men kun overfladen, ikke protokollen).

### Tilgang B — Headless socket.io-klient direkte mod serveren (intet modul)

Vores MCP-server agerer selv Foundry-klient: logger ind, åbner socket.io, og udsender de samme
`modifyDocument`-events **[VERIFICÉR]** som browseren ville.

**Fordele:** ingen modulinstallation; ingen åben browser nødvendig.
**Ulemper:** skal reverse-engineere (1) login/session-flow, (2) socket-handshake, (3) det udokumenterede
event-format — alt sammen **versionsfølsomt**. På The Forge skal man oveni gennem Forge's eget login
(`forge-vtt.com`) + proxy, hvilket gør auth markant sværere.

### Anbefaling

> **Byg Tilgang A (modul-relay) som primær.** Den er den eneste der er robust på The Forge og mod
> versionsskift. Brug §4's reverse engineering primært til at *forstå* skemaer og hook-livscyklus,
> og §5 (Tilgang B's socket-analyse) kun som dyb baggrundsviden / nødplan — ikke som leveringsvej.

---

## 4. Reverse engineering-metodik — Tilgang A (modul-API)

Målet her er at kortlægge nøjagtigt hvilke klient-API-kald der skaber hver dokumenttype korrekt,
så modulet kan udføre dem deterministisk.

### Fase A1 — Skaf en lokal testverden (sandbox)
- Kør en **lokal** Foundry V14 (samme `dnd5e 5.3.3` / `Core 14.363` som produktion) med en
  kopi af `Curse of Strahd`-verdenen. Aldrig reverse-engineer mod produktionsverdenen.
- Bekræft versioner: `game.version`, `game.system.id`, `game.system.version` i browserkonsollen.

### Fase A2 — Kortlæg dokument-API'et via browserkonsollen
Kør (som GM) i DevTools-konsollen og notér præcist input/output:

```js
// Actor
const a = await Actor.create({ name: "RE Test", type: "npc" });
console.log(a.toObject());                 // ← fuldt persisteret skema (sammenlign med actors/npcs/*.json)

// Scene (sammenlign mod buildScene() i import-scenes.js)
const s = await Scene.create({ name: "RE Scene", width: 2000, height: 1400 });

// Embedded docs (tokens/lys/noter) — VIGTIGT: hvordan tilføjes de live?
await s.createEmbeddedDocuments("Token",        [/* token-data */]);
await s.createEmbeddedDocuments("AmbientLight",  [/* lys-data */]);
await s.createEmbeddedDocuments("Note",          [/* note-data */]);

// Journal + pages
const j = await JournalEntry.create({ name: "RE Journal" });
await j.createEmbeddedDocuments("JournalEntryPage",
  [{ name: "Side 1", type: "text", text: { content: "<p>Hej</p>" } }]);
```

**Leverancer fra A2:**
- En **mapping-tabel**: ønsket handling → API-kald → minimal gyldig payload → returneret `_id`.
- Bekræftelse af at `buildToken/buildNote/buildLight`-payloads fra `import-scenes.js` accepteres af
  `createEmbeddedDocuments` (sandsynligvis efter mindre tilpasning — den offline-vej satte `_key` selv;
  det skal **fjernes** for live, da serveren genererer nøgler/`_id`).

### Fase A3 — Hook- og livscyklus-kortlægning
Forstå rækkefølgen, så modulet kan rapportere fejl og afvente færdiggørelse korrekt:
```js
Hooks.on("preCreateActor", (doc, data, opts, userId) => console.log("preCreate", data));
Hooks.on("createActor",    (doc, opts, userId)       => console.log("created", doc.id));
```
Notér: hvilke hooks er `pre*` (kan annullere/mutere), hvilke kører efter persistering, og hvad
`options`/`userId` indeholder (vigtigt for at undgå løkker i relayet).

### Fase A4 — Asset-håndtering (The Forge Assets Library — VERIFICERET)
Scener kræver baggrundskunst på en **servérbar sti**. Offline kopierer scriptet til
`worlds/<world>/assets/scenes/`. Live håndteres det gennem **Foundrys FilePicker**, og — afgørende —
**The Forge hooker FilePicker'en**, så de *samme* kald virker; man skifter bare kilde til `"forgevtt"`.

**Det installerede `forge-vtt`-modul eksponerer to globale klasser** (`ForgeVTT`, `ForgeAPI`) som vores
modul kan bruge direkte. Kortlagt API (fra Forge's egen udvikler-vejledning + modulets kilde):

```js
// 1. Detektér om vi kører på The Forge
if (typeof ForgeVTT !== "undefined" && ForgeVTT.usingTheForge) { /* Forge-sti */ }

// 2. Opret (nestede) mapper i ét kald — ingen rekursion nødvendig
await FilePicker.createDirectory("forgevtt", "curse-of-strahd/scenes");

// 3. Upload asset → svaret indeholder den absolutte Assets-Library-URL
const res = await FilePicker.upload("forgevtt", "curse-of-strahd/scenes", fileObj);
// res.path === den servérbare URL (CDN: assets.forge-vtt.com/<userId>/...) → brug som scene-baggrund

// 4. Tjek/browse eksisterende assets (idempotens)
const lib = await FilePicker.browse("forgevtt", "/", { recursive: true }); // { dirs, files }

// 5. Assets-Library-rod (URL-præfiks)
const prefix = ForgeVTT.ASSETS_LIBRARY_URL_PREFIX + (await ForgeAPI.getUserId()) + "/";
```

**Konsekvenser for designet (forenkler hullet betydeligt):**
- **Inde i Foundry-på-Forge** (vores arkitektur): upload er **automatisk autentificeret** via sessionen —
  **ingen API-nøgle nødvendig**. Asset-stien i §3 (kopier-til-`worlds/...`) bortfalder; vi bruger
  `res.path` direkte som `scene.background.src`.
- **Kildevalg er det eneste der skifter:** `"data"` (standalone) vs `"forgevtt"` (Forge). Modulet
  detekterer med `ForgeVTT.usingTheForge` og vælger kilde — ét `if`. Resten af `create_scene` er ens.
- **CDN gratis:** Forge-assets serveres fra `assets.forge-vtt.com/<userId>/...`, så scene-baggrunde
  loader hurtigt for spillerne uden ekstra arbejde.
- **API-nøgle kun udenfor Forge:** hvis vi senere vil have MCP-serveren til at uploade *direkte* til
  Assets Library (uden om modulet/en åben klient), bruges en API-nøgle fra forge-vtt.com's
  *API Key Manager* via `ForgeAPI.call(...)` (bearer). Ikke nødvendigt for den valgte "modul-i-åben-GM"-model.

> Dette var tidligere planens største Forge-ukendte. Det er nu løst: asset-upload på Forge er
> **samme FilePicker-kald med kilde `"forgevtt"`**, auto-autentificeret inde i klienten.

### Fase A5 — Byg modul-skelet
Minimal `module.json` + `init`/`ready`-hook der åbner WebSocket til relay og dispatcher kommandoer.
Sikkerhed: kun GM må udføre skrivninger; relay-forbindelsen skal autentificeres (delt token).

### Fase A6 — Modul-UI og -konfiguration (V14)
Modulet har brug for konfiguration (relay-URL, token) og gerne et status-/dry-run-vindue.
- **Konfiguration:** `game.settings.register(...)` for relay-URL, token, "auto-execute vs. bekræft".
  Ofte tilstrækkeligt i sig selv — kræver ikke et vindue.
- **Status/preview-UI (valgfrit):** byg med **`ApplicationV2`** (+ `HandlebarsApplicationMixin`) — det
  nye UI-framework i V13+/V14. Bemærk: `ApplicationV2` er rendering/vindue-livscyklus
  (`render()`, `_onSubmitForm()`, `close()`), **ikke** et dokument-API; det skaber *ikke* selv actors/scener.
  Brug det til: forbindelsesstatus ("Relay forbundet ✓", sidste kommando), dry-run-preview/bekræftelse
  før skrivning, og en debug-/manuel-kommando-dialog.
  Ref: <https://foundryvtt.com/api/classes/foundry.applications.api.ApplicationV2.html>
- **Vigtigt for V14:** gammel `Application`/`FormApplication` er afløst af `ApplicationV2`; alt nyt UI
  skal bygges på den nye klasse.

---

## 5. Reverse engineering-metodik — Tilgang B (socket-protokol, baggrund/nødplan)

Kun nødvendig hvis modul-fri drift bliver et krav. Dokumenteres her så viden ikke går tabt.

### Fase B1 — Login/session
- Standalone Foundry: `POST /join` med `{ userid/adminPassword, ... }` → sætter `session`-cookie.
  Kortlæg felterne i `/join`-formen og svaret.
- **The Forge:** login sker på `forge-vtt.com` (OAuth/session) → game-session proxies under
  `https://<dig>.forge-vtt.com/game`. Kortlæg cookie/headers via DevTools → Network. Forventeligt
  betydeligt mere indviklet end standalone.

### Fase B2 — Socket-handshake
- Inspicér WebSocket-frames i DevTools (Network → WS) når browseren forbinder. Notér socket.io-version,
  query-parametre (`session`), namespace, og første `world`/`setup`-payload serveren sender.

### Fase B3 — Dokument-events **[VERIFICÉR alle navne/formater]**
- Trig en `Actor.create()` i konsollen og fang den udgående frame. Forventet form (skal bekræftes):
  ```
  emit("modifyDocument", { type: "Actor", action: "create", operation: { data: [...] } }, ackCallback)
  ```
- Kortlæg `create`/`update`/`delete` og embedded (`type: "Token", parentUuid: "Scene.xxx"` e.l.).
- Byg en tynd headless-klient med `socket.io-client` der replikerer frames og lytter på ack.

> **Advarsel:** Disse event-navne og -former er **interne og udokumenterede** og kan ændre sig mellem
> Foundry-versioner. Derfor er Tilgang A at foretrække som leverancevej.

---

## 6. Referencearkitekturer (eksisterende community-arbejde at lære af)

Genopfind ikke hjulet — studér og verificér mod disse (tjek licens før kodegenbrug):

- **`foundryvtt-rest-api` (Foundry-modul) + tilhørende relay-server** — netop modul-relay-mønsteret
  fra Tilgang A: modul åbner WebSocket til en relay, der eksponerer et REST/WebSocket-API udadtil.
- **`foundry-mcp` / "Foundry VTT MCP"-projekter** — MCP-servere der wrapper ovenstående til
  MCP-værktøjer (`create_actor`, `search_compendium`, …). Direkte skabelon for vores MCP-lag.
- **Foundry's egne API-docs** (`foundryvtt.com/api/`) — autoritativ kilde for `Document`,
  `WorldCollection`, `FilePicker`, Hooks. Brug til at bekræfte alt **[VERIFICÉR]**.
- **The Forge's dokumentation / Assets-API** — for §4 Fase A4 og §5 B1 (Forge-auth + assets).

**Aktivitet:** Lav et kort sammenlignings-notat: hvilke af disse understøtter V14 + dnd5e, hvilken
licens, og hvad vi kan genbruge vs. skal skrive selv. Dette kan afkorte hele projektet markant.

### Verificering (juni 2026) — konkrete fund

Kortlagte projekter:

| Projekt | Arkitektur | Foundry | System | Licens | Relevans |
|---------|-----------|---------|--------|--------|----------|
| **`adambdooley/foundry-vtt-mcp`** | MCP-server ↔ WebSocket ↔ modul ↔ Foundry (Tilgang A) | v13 min, **v14 verified+max** | **dnd5e** + flere; "fleste tools system-agnostiske" | **MIT** | ★ Bedste match — se nedenfor |
| `ThreeHats/foundryvtt-rest-api` (+ `-relay`) | modul ↔ WebSocket-relay → REST | tjek release | system-agnostisk | tjek repo | God hvis vi vil have et rent REST-lag |
| `laurigates/foundryvtt-mcp` | MCP-server mod Foundry | tjek | query/roll/generér | tjek | Alternativ MCP-impl. |
| `TheStranjer/foundry-vtt-mcp` | direkte WebSocket, native Foundry-auth (Tilgang B) | tjek | — | tjek | Reference for nødplan/Tilgang B |

**`adambdooley/foundry-vtt-mcp` (modul v0.8.2) — anbefalet udgangspunkt:**
- ✅ **Kompatibilitet matcher prod:** Foundry v13 min, **v14 verified/maximum** (jeres `Core 14.363`).
- ✅ **dnd5e eksplicit understøttet** (har dedikeret dnd5e NPC-oprettelse); de fleste tools er system-agnostiske.
- ✅ **MIT-licens** → fri genbrug/fork (plus tredjeparts-licenser for bundlede installer-komponenter).
- ✅ **Arkitektur = vores Tilgang A:** `MCP-server ↔ WebSocket ↔ Foundry-modul ↔ Foundry VTT`.
- ✅ **GM-only** (matcher vores sikkerhedskrav), **bygget til Claude** (+ lokale LLM'er).
- ✅ **~40 værktøjer:** actors/NPC-oprettelse, journals/quests, tokens, items, conditions, terningkast,
  scene-info, kort-/map-generering, kampagne-dashboards, compendium-søgning.
- ✅ **WebRTC-tilstand til remote-forbindelser** — lovende for **The Forge** (skal stadig verificeres i Forge-spike).

**Huller der stadig skal verificeres mod adambdooley før vi committer til det:**
1. **Fuld scene-oprettelse:** dækker det `Scene.create` **med embedded tokens/lys/note-pins** som jeres
   `generated/scenes/`-specs (ikke kun "map generation"/scene-info)? Hvis ikke → vores `create_scene` oven på.
2. **Forge end-to-end:** virker WebRTC/WebSocket-tilstanden gennem Forge's proxy med en åben GM? (Fase 2-spike.)
3. **Datakontrakt:** kan vi fodre vores `generated/`-skemaer direkte ind, eller skal der en adapter til?
4. **Pålideligheds-lag (§11):** har det read-back-verificering/rollback, eller skal vi lægge det ovenpå?

**Anbefaling:** Start med at **fork/prøve `adambdooley/foundry-vtt-mcp`** mod sandbox (MIT tillader det).
Behold vores §7-dækningsmål og §11-pålidelighedslag som det vi *tilføjer* oven på, hvor projektet ikke
allerede dækker. Det kan spare det meste af Fase 3–4.

### Gap-analyse: hvad vi får gratis vs. hvad vi selv skal bygge

Kortlagt fra kildekoden (`packages/mcp-server/src/tools/*` + `systems/dnd5e/`):

**✅ Får gratis (genbrug direkte):**
- **Hele transport-/infrastrukturlaget** — det svære stykke: MCP ↔ WebSocket/WebRTC ↔ modul ↔ Foundry,
  GM-only, V14, Claude-integration, job-kø, lock, reconnect.
- **Læse-/query-værktøjer:** `get-current-scene`, `get-world-info`, compendium-søgning, karakter-query.
- **Compendium-klon af actors:** `create-actor-from-compendium` (packId/itemId → klon, evt. `addToScene`).
- **dnd5e NPC-stilladsbygning:** `dnd5e-create-npc` tager en rig **custom stat block** (identitet, hp/ac,
  abilities, saves, bevægelse, sanser, skills, traits, sprog, biografi).
- **Token-manipulation** (flyt/opdatér/slet på aktiv scene), terningkast, quests/journals, conditions, ownership.
- **Kort-generering:** `generate-map` (ComfyUI-billede → backend importerer som **basal** scene).

**🔨 Skal selv bygges oven på (de reelle huller):**

| Hul | Hvad mangler i adambdooley | Vores tilføjelse |
|-----|----------------------------|------------------|
| **#1 Fuld scene-montage** | `scene.ts` er **read-only**; `generate-map` laver kun en *basal* scene fra et billede — **ingen** placering af lys, note-pins eller forud-bestemte tokens fra en spec | `create_scene` der laver `Scene.create` + `createEmbeddedDocuments(Token/AmbientLight/Note)` fra `generated/scenes/`. **Genbrug `import-scenes.js`' `buildScene/buildLight/buildToken/buildNote` ordret** (minus `_key`) — offline og live deler så bygger-kode |
| **#3 Actor-datakontrakt** | `dnd5e-create-npc` tager *dekomponeret* input og tilføjer **ikke** items/feats/weapons/spells (kræver separate `dnd5e-add-feature`-kald). Vores `generated/npcs/*.json` er derimod et **færdigt Foundry-actor-dokument med `items[]` + `effects[]`** | Tilføj ét generisk **`create_document`** der tager rå Foundry-JSON direkte → `Actor.create(json)`. Matcher præcis offline-importen og genbruger jeres skema 1:1. (Alternativt: adapter `generated/npcs` → `dnd5e-create-npc` + N×`add-feature` — mere arbejde, mere skrøbeligt) |
| **#4 Pålidelighed (§11)** | Værktøjerne ser ud til at være "udfør-og-rapportér" uden read-back-verificering/rollback | Læg validér→verificér→rollback-pipelinen oven på vores egne create-værktøjer |
| **#2 The Forge** | **Assets: LØST** — `forge-vtt`-modulet hooker FilePicker; `FilePicker.upload("forgevtt", …)` virker auto-autentificeret inde i klienten (se §4 A4). Tilbage: verificér kun **forbindelsen** (WebRTC/`webrtc-peer.ts`) gennem Forge's proxy med åben GM | Brug `"forgevtt"`-kilde i `upload_asset`/`create_scene`; reduceret Forge-spike (kun connectivity) |

**Konklusion — den rene arkitektur:** fork projektet for transport + læse-/hjælpe-værktøjer, og tilføj
**tre** egne skrive-værktøjer: et generisk **`create_document`** (rå Foundry-JSON → `X.create`, dækker
actors/items/journals/**roll tables** m.m. fra `generated/`), et **`create_scene`** (genbruger
`import-scenes.js`' dokument-byggere) og et **`create_quest`** (kalder Forien's Quest Log's API, §7.1).
Det giver fuld paritet med offline-importen *og* dækker hullerne — med minimal ny kode.

---

## 7. MCP-serverens design (oven på relayet)

Når modul-relayet kan udføre kommandoer, er MCP-laget tyndt. Værktøjer (tool surface):

For en **fuld** integration skal værktøjsfladen dække **alle** dokumenttyper, ikke kun de tre første.
Bygges generisk: ét sæt CRUD-værktøjer parametriseret på dokumenttype, plus et par specialiserede.

**Kerne (generiske CRUD — dækker alt på én gang):**

| MCP-værktøj | Mapper til (klient-API) | Noter |
|-------------|-------------------------|-------|
| `create_document` | `CONFIG[type].documentClass.create(data)` | `type` ∈ Actor, Item, Scene, JournalEntry, Macro, RollTable, Playlist, Cards, Folder… |
| `update_document` | `doc.update(changes)` | upsert via `_id`/navn-opslag |
| `delete_document` | `doc.delete()` | kræver bekræftelse / dry-run |
| `create_embedded` | `parent.createEmbeddedDocuments(type, [...])` | Token, AmbientLight, Note, Wall, Tile, Drawing, Region, AmbientSound, JournalEntryPage, ActiveEffect, Item-på-actor |
| `update_embedded` / `delete_embedded` | `parent.update/deleteEmbeddedDocuments(...)` | f.eks. flyt tokens, juster lys |
| `find_document` | `game[collection].getName()` / `.get(id)` | navn→`_id` (erstatter `loadWorldIndex`) |
| `query_world` | `game[collection].search/filter` | lister/søger inden agenten handler |

**Specialiserede (bekvemmelighed + korrekthed for komplekse typer):**

| MCP-værktøj | Mapper til | Input (genbruger eksisterende skemaer) |
|-------------|-----------|----------------------------------------|
| `create_npc` / `update_npc` | `Actor.create/update` (+ embedded items/effects) | `generated/npcs/{slug}.json` (uændret skema) |
| `create_scene` | `Scene.create` + `createEmbeddedDocuments` | `generated/scenes/{slug}.json` (uden `_key`) |
| `create_journal` | `JournalEntry.create` + pages | `generated/journals/{slug}.md` → HTML |
| `upload_asset` | `FilePicker.upload("data"\|"forgevtt", …)` | lokal fil → servérbar sti; Forge auto-auth, returnerer CDN-URL (§4 A4) |
| `set_active_scene` / `pull_players` | `scene.activate()` / `view()` | kør under spil |
| `roll_table` / `post_chat` | `RollTable.draw()` / `ChatMessage.create()` | runtime-automation |
| `import_from_compendium` | `game.packs.get(...).getDocument(id)` → `create` | genbrug SRD/modul-indhold |
| `create_quest` / `update_quest` | **Forien's Quest Log** `Quests.create(...)` (§7.1) | quest-spec → FQL (IKKE rå JournalEntry) |

**Dækningsmål (alt — actors, NPC, journals, roll tables og resten):** alt der har en `Document`-klasse
i Foundry nås gennem `create_document` / `create_embedded`. Eksplicit dækket:

- **World-dokumenter:** Actor (PC/NPC), Item, Scene, JournalEntry, **RollTable**, Playlist, Macro,
  Cards, Folder, Combat (encounters), ChatMessage, Setting.
- **Embedded:** Token, AmbientLight, AmbientSound, Note (pin), Wall, Tile, Drawing, Region,
  TableResult (roll-table-rækker), PlaylistSound, JournalEntryPage, ActiveEffect, Item-på-actor,
  Combatant.
- **Modul-dokumenter med egne API'er:** f.eks. **quests via Forien's Quest Log** (§7.1) — disse går
  *ikke* gennem `create_document`, men gennem modulets eget API, fordi data ligger i modul-specifikke flags.

De specialiserede værktøjer er "guard rails" for de typer hvor vi allerede har modne skemaer
(`generated/`) eller hvor et modul kræver sit eget API. Det giver *fuld* dækning uden ét værktøj pr. type.

**Designprincipper:**
- **Genbrug `generated/`-skemaerne** som MCP-input, så offline- og live-vejen deler datakontrakt.
  Et spec der virker med `npm run import:scenes` skal kunne sendes til `create_scene` (minus `_key`).
- **Idempotens som i dag:** gem returneret `_id` tilbage i spec-filen (samme mønster som `import-scenes.js`).
- **Dry-run paritet:** behold en `--dry-run` der viser den fulde payload før afsendelse.
- **Auth:** MCP-server ↔ relay ↔ modul beskyttes med et delt hemmeligt token (aldrig i git; brug `.env`).

### 7.1 Modul-integrationer: Forien's Quest Log (FQL) — quests til spillerne

Quests skal **ikke** laves som rå `JournalEntry`. FQL gemmer quest-data i **modul-specifikke flags** med
sin egen struktur (tasks, rewards, sub-quests, status, giver) og rendrer sit eget Quest Log-UI til
spillerne. Går vi uden om FQL's API, ender vi med journaler FQL ikke kan se. Derfor: **kald FQL's eget API.**

**Kortlagt FQL Quests-API** (fra modulets Developers-wiki):

```js
// Opret en quest
Quests.create({
  actor:       "<Actor._id>",   // quest-giver (påkrævet i den dokumenterede form)
  title:       "Find Ireena i Vallaki",
  description: "<p>HTML-beskrivelse til spillerne…</p>",
  gmnotes:     "<p>GM-noter (skjult)…</p>" /* eller null */,
  tasks:       [ /* objektiver */ ],
  rewards:     [ /* belønninger */ ],
});

Quests.get(questId);            // hent quest-instans
Quests.open(questId);           // åbn Quest Details-vinduet
// Under-API'er til at bygge indhold:
task.create({ name: "Tal med Fader Donavich", hidden: false });
reward.create({ type: "Item" | "Abstract", data: {/*…*/}, hidden: false });
```

**[VERIFICÉR] Adgangssti + V14-kompatibilitet:** den nøjagtige globale adgang er versionsafhængig —
typisk `game.modules.get("forien-quest-log").public.QuestAPI` (nyere) eller et globalt `Quests`-objekt
(ældre). Bekræft mod **din installerede version** i konsollen (`game.modules.get("forien-quest-log")`),
og at FQL kører på Foundry V14. Status-værdier (active/inactive/completed/failed) og giver-typer
(Actor/Item/JournalEntry) bekræftes samme sted.

**Vores værktøj `create_quest`:** modulet kalder FQL's `Quests.create(...)` (ikke `create_document`).
Input bliver et lille **quest-spec** vi kan lægge i `generated/quests/{slug}.json` (Dansk titel/beskrivelse,
giver-navn → `_id`-opslag, tasks, rewards) — samme `generated/`-mønster, `_id` skrives tilbage for idempotens.

**Generelt mønster for modul-integrationer:** for ethvert modul med indhold i flags (FQL, Monk's Enhanced
Journal, Item Piles, …) wrapper vi modulets **public API** i et dedikeret MCP-værktøj frem for at skrive
rå dokumenter. FQL er den første; samme skabelon genbruges til næste modul.

### 7.2 Opdatering og ændring (in-place modifikation — "ret X, og det opdateres i Foundry/Forge")

Integrationen er **fuld livscyklus**, ikke kun oprettelse: alt der kan skabes kan også **ændres** og
**slettes** live. Når du beder om en ændring ("gør Strahd CR 16", "flyt bålet", "tilføj et objektiv til
quest'en", "byt scene-baggrunden"), rammer den det **eksisterende** objekt — ingen dublet.

**Sådan finder og ændrer systemet det rigtige objekt:**

1. **Find målet.** Via `_id` gemt i `generated/**`-spec'et (foretrukket), ellers navne-opslag
   (`find_document` → `game.actors.getName()` osv.). Findes intet match → `create`; findes det → `update`.
   Det er præcis upsert-mønsteret fra `import-scenes.js`, nu også for opdateringer.
2. **Delvis ændring (patch, ikke overskriv).** `doc.update({ "system.details.cr": 16 })` ændrer *kun*
   det felt du bad om; Foundry fletter resten. Vi sender altså en **diff**, ikke hele dokumentet —
   så uberørte felter (og manuelle GM-justeringer) bevares.
3. **Embedded ændres tilsvarende:** flyt/justér tokens, lys, note-pins, roll-table-rækker via
   `parent.updateEmbeddedDocuments("Token", [{ _id, x, y }])`; tilføj/fjern med create/delete-Embedded.
4. **Modul-indhold via modulets API:** quest-ændringer går gennem FQL (`Quests.get(id)` → opdatér tasks/
   rewards/status), ikke rå journal-skrivning (§7.1).
5. **Verificér + rollback (§11):** efter `update` læses dokumentet tilbage og sammenlignes; mismatch →
   rollback fra snapshot. Destruktive ændringer/sletninger tager backup først.

**Dækning:** `update_document` / `update_embedded` / `delete_document` / `delete_embedded` (+ `update_quest`)
dækker **alle** typer fra §7 — actors, NPC, scener, journaler, roll tables, lys, tokens, quests osv.
Samme på lokal og **Forge** (det er Foundrys dokument-API, ikke en filsti — så Forge gør ingen forskel,
fraset assets der bruger `"forgevtt"`-kilden, §4 A4).

> Konkret: "ret Strahds AC til 18 og skift hans portræt" → `find_document(Strahd)` → `update_document`
> med `{ "system.attributes.ac.flat": 18, "img": "<ny upload-sti>" }` → read-back-verificér → done,
> live i spillernes verden.

---

## 8. Risici, versionsfølsomhed og sikkerhed

| Risiko | Konsekvens | Afbødning |
|--------|-----------|-----------|
| Interne socket-events ændrer sig (Tilgang B) | Brud ved Foundry-opdatering | Foretræk Tilgang A (officielt API) |
| The Forge proxy/auth blokerer headless | Tilgang B virker ikke på prod | Tilgang A (udgående fra klient) |
| Asset-upload virker anderledes på Forge | Scener uden baggrund | Egen spike i Fase A4 mod Forge |
| Skrivning mod **produktions**verden | Datatab | Altid backup + test mod sandbox-kopi først; behold offline LevelDB-backup-mønsteret |
| Token/relay lækket | Uautoriseret skrivning til verdenen | GM-only guard i modul; token i `.env`; roter ved behov |
| GM-klient ikke åben | Kommandoer fejler (bryder "uden manuel indgriben") | Vedvarende headless GM-session + watchdog (§12) |
| Delvis batch-skrivning | Inkonsistent verden (scene uden tokens) | Atomar batch + rollback (§11) |
| Foundry afviser data live | Stille fejl / forkert indhold | Validér + read-back-verificér + struktureret fejlrapport (§11) |
| FQL's API/adgangssti ændrer sig pr. version | `create_quest` brækker | [VERIFICÉR] adgangssti mod installeret version; wrap i ét sted (§7.1); fald tilbage til rå JournalEntry-flags kun som nødløsning |

**Vigtigt sikkerhedsforhold:** dette er en *autoriseret* udvidelse af din egen kampagne. Hold relay-
serveren privat (ikke offentligt eksponeret uden auth), og commit aldrig tokens/Forge-API-nøgler.

---

## 9. Faseinddelt køreplan med milepæle

| Fase | Leverance | "Færdig når…" |
|------|-----------|----------------|
| 0. Setup | Lokal V14-sandbox med CoS-kopi | `game.version`/`system` matcher prod; sandbox kører |
| 1. RE skema | Mapping-tabel (A2) + hook-noter (A3) | Actor/Scene/Journal kan skabes fra konsollen og payloads matcher `generated/`-skemaer |
| 2. Asset-spike | Upload virker lokalt **og** på Forge (A4) | En baggrund kan uploades og bruges i en live scene begge steder |
| 3. Modul-skelet | `module.json` + WS-relay-klient (A5) | Modul forbinder til lokal relay; udfører ét hardcodet `create_actor` |
| 4. Relay + MCP | Relay-server + MCP-værktøjer (§7) | `create_npc`/`create_scene`/`create_journal` virker mod sandbox |
| 5. Forge-validering | Hele kæden mod The Forge | Samme tre værktøjer virker mod prod-Forge-verden (med backup) |
| 6. Idempotens/paritet | `_id`-write-back, `--dry-run`, datakontrakt delt med offline | Et `generated/`-spec kan importeres begge veje |
| 7. Fuld dækning | Generiske `create_document`/`create_embedded` (§7) | Alle dokumenttyper kan oprettes/opdateres/slettes |
| 8. Pålideligheds-lag | Validér→dry-run→skriv→verificér→rollback (§11) + CI-suite | Test opretter+verificerer+sletter hver type; fejl rapporteres struktureret |
| 9. Autonom GM | Vedvarende headless GM-session + watchdog (§12) | Kommandoer virker 24/7 uden at du har en browser åben |
| (valgfri) 10. Tilgang B | Headless socket-PoC (§5) | Kun hvis modul-fri drift ønskes |

---

## 10. Konkrete første skridt (uge 1)

1. **Verificér referenceprojekter (§6)** — afgør om `foundryvtt-rest-api`/`foundry-mcp` allerede dækker
   V14+dnd5e og hvad licensen tillader. *Dette kan halvere arbejdet.*
2. **Rejs lokal sandbox (Fase 0)** med en kopi af CoS-verdenen.
3. **Kør A2-konsoleksperimenterne** og udfyld mapping-tabellen — start med `Actor.create` (simplest,
   genbruger `actors/npcs/`-skemaet direkte).
4. **Forge asset-spike (A4)** tidligt, da det er den største ukendte for The Forge.
5. **Beslut:** byg eget modul vs. fork af eksisterende. Skriv beslutningen ned her i dokumentet.

---

## 11. Pålideligheds-laget ("uden fejl")

Dette er hjertet i kravet om at opgaver udføres **automatisk og uden fejl**. Hver write-operation går
gennem en fast pipeline frem for et rå API-kald. Princip: *fail closed, verify always.*

```
AI/spec ─▶ 1.VALIDÉR ─▶ 2.DRY-RUN ─▶ 3.SKRIV ─▶ 4.VERIFICÉR (read-back) ─▶ 5.PERSISTÉR _id
              │ fejl        │ afvig        │ fejl        │ mismatch
              ▼             ▼              ▼             ▼
           afvis &     vis diff &      auto-retry    rollback + rapportér
           rapportér   (valgfri        (idempotent)  (ingen stille fejl)
                       bekræftelse)
```

| Trin | Hvad | Hvordan |
|------|------|---------|
| 1. **Validér** | Fang fejl før de rammer Foundry | JSON-schema for hver dokumenttype (afledt af `generated/`-skemaerne + Foundrys `DocumentSchema`); afvis manglende/ugyldige felter |
| 2. **Dry-run** | Vis præcis payload + diff mod nuværende tilstand | Genbrug `--dry-run`-mønsteret fra `import-scenes.js`; for `update` vis felt-diff |
| 3. **Skriv** | Idempotent upsert | `_id` findes → `update`, ellers `create`; aldrig blind dobbelt-`create` |
| 4. **Verificér** | Bekræft at resultatet matcher intentionen | Læs dokumentet tilbage (`game.x.get(id)`), sammenlign nøglefelter; mismatch = fejl |
| 5. **Persistér** | Gør operationen reproducerbar | Skriv returneret `_id` tilbage i spec-filen (som i dag) |

**Yderligere garantier:**
- **Atomare batches:** flere relaterede docs (scene + tokens + lys + noter) skrives i én logisk
  transaktion; delvis succes rulles tilbage (slet det halvfærdige) så verdenen aldrig efterlades inkonsistent.
- **Auto-retry med backoff** på transiente fejl (Forge-timeout, socket-drop) — bounded, så det ikke looper.
- **Backup før destruktive ops:** `delete`/`update` af eksisterende docs tager et snapshot (genbrug
  backup-mønsteret fra `import-scenes.js`); muliggør manuel rollback.
- **Pre-flight world-tjek:** før en batch — er GM forbundet? er det rette verden/version aktiv?
  Ellers afvis straks med klar besked frem for halvt at udføre.
- **Struktureret fejlrapport tilbage til AI:** hvert fejlet kald returnerer `{ ok:false, stage, reason,
  doc, hint }` så agenten kan selv-korrigere (f.eks. mangler et felt → ret spec → prøv igen).
- **Hook-loop-beskyttelse:** relayet markerer egne writes (flag/`userId`) så modulets `createX`-hooks
  ikke trigger nye kommandoer tilbage til relayet.

**Test/CI for tilliden:** en suite mod sandbox der opretter → verificerer → opdaterer → sletter hver
dokumenttype og fejler hvis read-back afviger. Det er det der gør "uden fejl" til noget målbart frem for
et løfte. (En `validate`-paritet med nuværende `npm run validate` bør udvides til at dække live-payloads.)

---

## 12. Autonomi: vedvarende GM-session (kør uden manuel indgriben)

"Automatisk og uden manuel indgriben" kræver at en GM-klient *altid* er forbundet — ellers fejler
kommandoer når ingen browser er åben. Anbefalet løsning:

- **Dedikeret headless GM-klient:** en headless browser (Puppeteer/Playwright) der logger ind som en
  dedikeret GM-bruger ("AI-GM"), indlæser verdenen og holder modulet + relay-forbindelsen kørende 24/7.
  Det er en *rigtig* klient → fuldt officielt API, virker på The Forge (udgående forbindelse).
- **Watchdog:** genopretter sessionen hvis den droppes (Forge-genstart, netværk); health-check + auto-relogin.
- **Adskil "AI-GM" fra din egen bruger:** egen konto/farve, så dens handlinger er sporbare i loggen og
  ikke kolliderer med at du selv er logget ind som GM.
- **Forge-hensyn:** tjek at planen tillader samtidige forbindelser/ekstra spiller-slot til AI-GM-kontoen,
  og at headless-login mod Forge's auth er stabilt (egen lille spike, beslægtet med §5 B1).

> Dette er det stykke der løfter løsningen fra "AI kan skrive når jeg har Foundry åben" til en
> **altid-på, fuldt autonom** integration. Det er en selvstændig fase (se opdateret køreplan).

---

### Bilag: åbne spørgsmål til afklaring
- Skal live-API'et **erstatte** offline-importen, eller leve **ved siden af** den (anbefalet: ved siden af —
  delt `generated/`-skema, to backends)?
- Er en permanent åben GM-klient acceptabel, eller er modul-fri (Tilgang B) et hårdt krav?
- Hvilken Forge-plan/tier hostes verdenen på (påvirker Assets-API og evt. custom moduler)?
