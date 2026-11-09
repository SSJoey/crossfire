# Crossfire: decisions and deviations

Every answer to an open question and every deviation from BRIEF.md, dated.

## 2026-11-02: Stage 1a planning (session for slice 1a.1)

### Process

- Stage 1a is split into three slices, one per session:
  - **1a.1**: repo setup, `shared/` types, tuning and pure rules, the authoritative server (lobby, 20 Hz sim, heroes, minions, waves, downed/revive) and network/lobby validation. Headless.
  - **1a.2**: KayKit asset pipeline, client (scene, units, input and aim, prediction, interpolation, HUD, end screen, graphics tiers), host page and join screen, Playwright smoke.
  - **1a.3**: JSON Lines match log, headless bots, load test, Docker Compose, 10-minute 8-player run; then security audit 1 and the playtest.

### Versions (checked against the npm registry and docs.colyseus.io on 2026-11-02)

- TypeScript **6.0.3**, not 7.0.2 (latest). Reason: typescript-eslint 8.72.1 supports `typescript >=4.8.4 <6.1.0`. Revisit when typescript-eslint supports TS 7.
- Colyseus 0.18: `@colyseus/core` 0.18.25, `@colyseus/schema` 5.0.43, `@colyseus/ws-transport` 0.18.4, `@colyseus/sdk` 0.18.9, `@colyseus/testing` 0.18.6, `@colyseus/tools` 0.18.11. We use `@colyseus/core` directly, not the umbrella `colyseus` package (that one pulls in Redis drivers, monitor and playground, none of which we need).
- Schema uses the `schema()` builder, so no decorator compiler flags.
- Vitest 5.0.5, ESLint 10.14, typescript-eslint 8.72.1, Prettier 3.9.10, Node 22.21 (Vitest 5 needs ≥ 22.12), tsx for running the server.
- Package manager: npm workspaces (`shared`, `server`, `client`); pnpm is not installed.

### Game rules (answers from JCCJ)

- **Starting tuning = look-test values**: ring radius 14; outside the ring drains 26 HP/s; inside regenerates 7 HP/s; Ember 400 HP, speed 5.4, fire bolt 20 damage every 0.55 s, range 12; Minion 42 HP, speed 1.75, 6 damage per 1.6 s swing; spawn radius 21–26; aim-assist cone 0.45 rad; heroes clamped to 40 m from the centre.
- **Waves are count-based**: wave N spawns `ceil((base + growth·(N−1)) · playerFactor(players))` minions, trickled in under the enemy cap. The next wave starts after a short break once the wave is cleared.
- **Enemy level rises every wave** (HP +12% per level as in the look test, plus smaller capped steps in damage, speed and size). JCCJ wants levels "growing up to bosses"; agreed that 1a only levels up the Skeleton Minion and bosses and other types stay in stage 1e.
- **Downed revive**: one teammate holds F for 3 s within the revive radius; the hero comes back at **50% HP**.
- **Enemies ignore downed heroes.** They only target standing heroes, so a downed hero dies only by the 20 s bleed-out.

### Deviation from the brief: full death

- BRIEF.md says the dead spectate (with one support flare per wave) and return at the intermission.
- **New rule:** a bled-out hero stays dead until revived. A full-death revive needs **every living (standing) player** within the revive radius, **all holding F at the same time**, for **5 s**. Letting go pauses the timer (it does not reset). The hero returns at **50% HP**.
- Consequence: when nobody is standing, the run ends (end screen).
- Open for 1f: how the support flare fits this rule. Parked until then.

### Lobby and host

- **Host = loopback check**: only a connection from 127.0.0.1 / ::1 counts as the host and may send start, restart and kick. No tokens. Docker must preserve client IPs (decided in 1a.3).
- **The host page is a control screen, not a player.** The host plays from a second tab and counts as one of the 8.
- **Names**: trimmed; empty or whitespace-only is refused with a message; duplicates get " 2", " 3" and so on; capped at 16 grapheme clusters (one emoji = 1).

### Defaults approved with the 1a plan (all tunable in `shared/tuning.ts`)

- Rate limit: token bucket, 60 messages/s with a burst of 120. Excess messages are dropped; a client that keeps flooding for 3 s is kicked.
- Stale input: no input for 250 ms means the hero stands still and its buttons count as released.
- Out-of-order input: each input carries a sequence number; anything at or below the last applied one is dropped.
- Invalid numbers: any NaN, Infinity or |x| > 1e4 drops the whole message. A move vector longer than 1 is normalised to length 1. The aim point is clamped to the map.
- Unknown message types and malformed payloads are dropped and counted; they never crash the room.
- Names: control characters and bidi override characters (U+202A–202E, U+2066–2069) are stripped; right-to-left letters are allowed.
- Late joiner during a run: refused with "Run in progress, you'll get in when it ends"; the join screen retries every 5 s (client, 1a.2).
- Ring edge: exactly 14 m counts as inside. The drain can down a hero. Downed heroes neither drain nor regenerate.
- Enemy cap 120. Break between waves 5 s. playerFactor(p) = 1 + 0.5·(p−1). base 6, growth 3. Revive radius 2 m.

## 2026-11-02: Slice 1a.1 build notes

### Tooling

- ESLint `@typescript-eslint/no-non-null-assertion` is off. `tsconfig` has `noUncheckedIndexedAccess`, so indexed reads into the fixed pools need `!`; keeping the stricter compiler check was preferred over the lint rule.
- `@colyseus/sdk`, `@colyseus/testing` and `@colyseus/tools` are dev dependencies of `server` (tests and tools only).
- `tools/smoke-server.ts` (`npm run smoke:server`): two clients go lobby → running → ended against a real server. First run: ended after 17.6 s, one `ended` message.

### Implementation choices (not in the brief; confirmed by JCCJ on 2026-11-02)

1. **Minion level steps**: damage +5% per level (cap ×2), speed +2% per level (cap ×1.4), size +1.5% per level (cap ×1.3). HP +12% of base per level, uncapped.
2. **Fire bolt speed** 22 m/s (the look test does not fix one); hit radius 0.15 m.
3. **Minion spawn rise** 0.6 s, during which it cannot be targeted or attack.
4. **Bleed-out keeps running while a teammate revives**; if the revive and the bleed-out finish in the same tick, the revive wins.
5. **A reviver works on the nearest body** within the radius (downed or dead), one body at a time.
6. **Start needs at least one player and every player ready.**
7. **Players can only join a room the host page has opened** (otherwise "The host page only works on the host laptop"). Stops a LAN client from creating stray rooms.
8. A player who leaves mid-run is removed (reconnect is stage 1f). If every player leaves, the room returns to the lobby.
9. Room code: 4 letters without I and O. Up to 4 host-page connections besides the 8 players.
10. WebSocket max message size 16 KB.
11. The server drops simulation backlog after 5 catch-up steps (a stall never makes it fast-forward).
12. Synced state allocates one schema object per spawned enemy and bolt (the simulation itself is pooled). Measure in the 1a.3 load test; pool the schema objects if it shows up.

## 2026-11-02: Slice 1a.2 planning (answers from JCCJ)

1. **KayKit source files** come from the official CC0 GitHub repos, pinned by commit (neither repo has releases):
   - Adventurers 1.0: `KayKit-Game-Assets/KayKit-Character-Pack-Adventures-1.0` @ `672074b73ba276876a19e8816ecdc5241817ab47`
   - Skeletons 1.0: `KayKit-Game-Assets/KayKit-Character-Pack-Skeletons-1.0` @ `15b62b9bad122f72926c10fb14d622c73819fa54`
   - `npm run fetch-assets` downloads the character GLBs + LICENSE into `assets/kaykit/` (33 MB, git-ignored). `npm run assets` writes the slimmed models to `client/public/models/`, which **are committed**, so a fresh clone builds without downloading.
2. **Own hero in 1a**: the camera follows your hero and only your hero has a gold "you" ground ring. Downed and dead heroes get a pulsing red ring with a revive progress arc. No name tags until 1f.
3. **Graphics tier**: High / Medium / Low select on the join screen, default Medium, remembered in localStorage; `?gfx=high|medium|low` overrides it.
4. **Prediction is client-only** (no server change). The client sends one input per server tick (50 ms), predicts its own hero with the shared `stepHero`, replays unacknowledged inputs on each snapshot and smooths the leftover error (time constant 100 ms); errors over 2 m snap. Facing is predicted from the aim point.
5. **Serving**: in production the game server also serves the built client (`client/dist`) on its own port: players use `http://<lan-ip>:2567/?code=ABCD`, the host page is `http://localhost:2567/host`. In development, Vite serves the client (port 5173, all interfaces) and the client talks to the game server on port 2567 directly. `GET /api/lan` lists the host's private IPv4 addresses (env `LAN_HOST` overrides; for Docker in 1a.3).

### Versions (npm registry, 2026-11-02)

three 0.187.0 (+ @types/three 0.187.0), vite 8.3.5, @colyseus/sdk 0.18.9 (client), qrcode 1.5.4 (+ @types/qrcode 1.5.6), express 5.3.0 (+ @types/express 5.0.6; peer dependency of @colyseus/core, mounted with `defineServer({ express })`), @gltf-transform/core, functions and extensions 4.5.1, meshoptimizer 1.3.0, @playwright/test 1.64.1.

### KayKit rigs and clips (checked in the files)

- Heroes and skeletons share the same 41-bone rig (same bone names). The pipeline still keeps one animation file per pack (`hero-anims.glb`, `skeleton-anims.glb`), because several skeleton clips exist only in the skeleton files.
- Hero clips kept: Idle, Running_A, Spellcast_Shoot, Hit_A, Lie_Down, Lie_Idle, Lie_StandUp, Death_A.
- Skeleton clips kept: Spawn_Ground_Skeletons, Walking_D_Skeletons, Idle_Combat, 1H_Melee_Attack_Chop, Hit_A, Death_A.

## 2026-11-02: Slice 1a.2 build notes

### How to run

- `npm run fetch-assets` (once, downloads KayKit sources), `npm run assets` (rebuilds `client/public/models/`).
- `npm run dev`: game server on 2567 + Vite on 5173 (all interfaces). Host page: `http://localhost:5173/host`. Colyseus answers cross-origin matchmaking requests from 5173 (checked).
- `npm run build && npm run server`: production, everything on 2567. Host page: `http://localhost:2567/host`.
- `npm run test:e2e`: Playwright smoke (Chromium only; first time: `npx playwright install chromium`).

### Implementation choices (not in the brief; for review)

1. Client tunables (interpolation delay 100 ms, snap 2 m, smoothing 0.1 s, join retry 5 s, death animation 3 s, camera offset/fov) live in `TUNING.client`.
2. `ROOM_CODE_LETTERS` moved from `HoldRoom.ts` to `shared/types.ts` so the join screen validates codes with the same alphabet.
3. **Shadows per tier**: on Medium and High the arena and heroes cast shadows; **enemies cast shadows on High only** (as in the look test), to keep 120 skeletons affordable on Medium.
4. **No web fonts**: system fonts with the look-test fonts as first choice if installed, because a game-night LAN may have no internet.
5. three.js 0.187 removed `PCFSoftShadowMap`; the client uses `PCFShadowMap`.
6. `window.__crossfire` exposes a read-only `{ phase, me: { x, z, status } }` for the Playwright test. It controls nothing.
7. Arena in 1a: ground, dirt, red outside zone, orange ring edge, hold platform + brazier. Torches, ruins, rocks, trees and the flag wait for the art pass (1g).
8. ~~The Mage keeps all its KayKit props, as in the look test.~~ Changed 2026-11-02 (JCCJ): Ember holds only the staff; see the body-part merge notes.
9. An enemy that disappears from the synced state during a run is treated as killed (death animation, then it sinks). The server removes enemies only when they die or the run resets.
10. The hero cast animation plays when a new bolt appears within 1.5 m of a hero (the server sends no attack event). The hero `Hit_A` clip is in the pipeline but not played yet (heroes are hit constantly; the red vignette and HP bar show damage).
11. Inputs are sent from the render loop, so a hidden tab stops sending; the server's 250 ms stale rule then makes that hero stand still. Window blur also releases all keys.
12. The host page shows a network address dropdown only when the machine has more than one private IPv4 address (e.g. a Docker bridge). Reloading the host page opens a new room with a new code.
13. "Back to lobby" on the host page works during a run too (it ends the run for everyone).
14. The name field accepts up to 64 characters; the server trims to 16 grapheme clusters as before.

### Performance notes for the 1a.3 load test

- Models: 8.2 MB of sources → 850 KB total (Mage 135 KB, Minion 140 KB, hero clips 313 KB, skeleton clips 255 KB), meshopt-compressed. (Superseded by the body-part merge below.)
- Client bundle 920 KB minified (250 KB gzip), almost all three.js. Fine on a LAN; Vite's 500 KB warning is expected.
- One mixer per enemy (120 mixers at the cap). Animation LOD is a candidate if the CPU budget is missed.

## 2026-11-02: Body-part merge (after the 1a.2 commit, agreed with JCCJ)

- `tools/merge-skinned.mjs` merges each character into **one skinned mesh with one primitive per material**: Mage 12 parts → **1 draw call**, Skeleton Minion 9 parts → **2** (bone material + eye glow). At the enemy cap that is about 250 draw calls instead of about 1,100.
- Skinned parts keep their joints and weights. Rigid props on bones (hat on `head`, cape on `chest`, staff and wand on `handslot.r`, both spellbooks on `handslot.l`) are bound to their bone with weight 1, vertices moved into bind space (three.js convention: bind matrix = mesh node world matrix).
- Checks: triangle counts equal before and after (Mage 5,683, Minion 5,288); bind-pose bounds equal to 5 decimals, both computed by skinning every vertex at rest; one skin per file; every weight set sums to 1 on a valid joint. Screenshots of idle, running and downed heroes show the props following their bones.
- Meshopt quantization gives the mesh an adjusted copy of its skin; the pipeline disposes the unused original.
- Character files are now 110 KB each (were 135 and 140 KB). Total model set about 790 KB.
- **Ember holds only the staff** (JCCJ, 2026-11-02): the pipeline drops the Mage's `1H_Wand`, `Spellbook` and `Spellbook_open` before merging (734 triangles). The hat and cape stay. This differs from the look test, which showed every prop. Mage is now 4,949 triangles and 98 KB.

## 2026-11-02: Slice 1a.3 planning (answers from JCCJ)

1. **Load test uses a test-only load room** (`hold_load`): heroes take no damage, the spawner keeps enemies at the cap, bots shoot normally. It is registered only when the server runs with `CROSSFIRE_LOAD_ROOM=1`; Docker never sets it.
2. **One match log file per run**: from start until the team wipes, the host goes back to the lobby, or everyone leaves.
3. **Docker uses `network_mode: host`**, so the host's browser still arrives as 127.0.0.1 for the host check and `/api/lan` sees the real LAN addresses. Linux only.
4. **Security audit 1: prepared here, run elsewhere.** This session writes the checklist and the prompt (`audits/audit-1.md`); the audit runs in a fresh session with no build context, as BRIEF.md says.
5. **Memory rule ("no steady growth")**: heap and RSS sampled every 10 s; pass if the median of the last 3 minutes is at most 1.10 × the median of minutes 2–5, plus 5 MB.
6. **FPS** is read from a `?fps=1` overlay in the client (off by default).
7. **10-minute acceptance run**: 1 player + 7 bots on normal rules; if the team wipes, the host restarts; the check is 10 minutes of total play with no visible desync.
8. **Perf samples go into every match log**, every 10 s (tick p95/max, heap, RSS, enemies, bolts, kB/s per client by name).

## 2026-11-02: Slice 1a.3 build notes

### How to run

- `npm run bots -- --code ABCD [--count 7] [--url http://127.0.0.1:2567]`: headless bots join the lobby, get ready by themselves (again 1 s after every return to the lobby) and play until Ctrl+C.
- `npm run load-test -- [--minutes 15] [--bots 8] [--cap 120]`: starts its own server on port 2597 with the load room, runs, then prints a PASS/FAIL table from the run's match log (`logs/load/`). `--bots 7` leaves a slot: the script prints a join link with `?fps=1`; it waits until everyone is ready. `--cap 80` for the High-tier fps check. For the in-browser fps check, run `npm run build` first so the test server serves the client.
- `?fps=1` on the join link shows fps (last second), 1% low, enemy count and tier in the top-left corner.
- Docker: `npm run docker:up` (`docker compose up -d --build`), `npm run docker:down`. Host page `http://localhost:2567/host`. Logs in `./logs`.

### Versions (npm registry and Docker Hub, 2026-11-02)

yaml 2.9.1 (dev, for the Docker config test); Docker image `node:22.23.4-bookworm-slim` (exact tag). `tsx` 4.23.15 moved from the root dev dependencies to `server` dependencies, because the container runs the server with it.

### Implementation choices (not in the brief; for review)

1. **Match log lines**: `start` (ISO time, code, seed, names), `waveStarted`/`waveCleared`, `downed`/`died`/`revived` (name), `left` (name, reason `left`/`kicked`/`flooded`), `perf` every 10 s, `end` (reason `wiped`/`aborted`/`empty`, wave, duration, kills, whole-run tick and patch p95). Every line starts with `t` (ms since the run started) and `ev`. File: `logs/<ISO start time>_<CODE>.jsonl`. No IPs or session ids.
2. **Tick time** is measured in two parts: the simulation step + state mirroring (`tickP95Ms`) and Colyseus' state encode + send (`patchP95Ms`, by timing `broadcastPatch()`). The load-test budget check uses **their sum** against 10 ms (the stricter reading of "server tick").
3. **Bandwidth per client** is read from the WebSocket's TCP socket byte counter (`client.ref._socket.bytesWritten`, a private field of ws 8.x; framing included). If a future ws changes it, the perf line reports 0 and the matchlog integration test fails.
4. A relative `LOG_DIR` is taken from the repo root (the server runs from `server/`). Tests write logs to the system temp folder; Playwright to `test-results/logs`.
5. **Load room tuning** (`loadTuning`): minion damage 0, ring drain 0, waves never run out, one spawn per tick, cap from the host's `enemyCap` (clamped to 1..120). Minions still walk, swing and die; bolts still fly.
6. **Load-test budget numbers** (`TUNING.loadTest`): warm-up 2 min; memory early window 2–5 min vs the last 3 min; load held = ≥ 95% of the cap in ≥ 90% of samples; for runs too short for the memory windows, memory is reported "n/a" (not a pass, not a fail).
7. **Bot behaviour** (`tools/bots/brain.ts`): revive the nearest downed/dead teammate within ring + 4 m, otherwise stay within 70% of the ring radius, drift around the platform, shoot the nearest targetable enemy within bolt range, back off from enemies closer than 2 m. Bot constants live in the brain file because they shape test traffic, not the game.
8. **Docker**: two-stage build, runtime runs as `node` (uid 1000, so log files belong to the host user), read-only root filesystem with `/tmp` as tmpfs, all capabilities dropped, `no-new-privileges`, `restart: unless-stopped`, health check on `/api/lan`. The runtime image also installs the client's production dependencies (npm workspaces); harmless, only size.
9. **Docker runs with sudo** (JCCJ, 2026-11-02): no `docker` group, because membership is root-equivalent. The host starts the server with `sudo docker compose up -d`. Rootless Docker was ruled out: in rootless mode `network_mode: host` doesn't use the laptop's real network, which breaks the loopback host check.

### Load test result (2026-11-02, reference laptop, 8 bots, 120 enemies, 15 min): PASSED

- Tick p95 over the run: simulation 0.85 ms + state patch 0.8 ms = **1.7 ms** (budget 10 ms). Worst 10 s window p95 1.75 + 1.2 ms; worst single tick 4.2 ms.
- Memory: heap median 24.4 MB (min 2–5) → 26.2 MB (last 3 min), limit 31.8; RSS 124.6 → 133.4 MB, limit 142.1. RSS rose from 109 MB in the first minute and flattened after about minute 10; recheck on a longer run.
- Load held: ≥ 114 enemies in 100% of samples; 4,319 kills. 8/8 bots connected at the end.
- **Bandwidth per client: about 42.5 kB/s average, 43.9 kB/s max** (all clients see the same state). Ceiling still to be set, as the brief says.
- Note #12 (one schema object per spawned enemy and bolt) did not show up: no pooling needed.
- A Docker image build overlapped the last minutes of the run.
- Still to measure by hand: client fps on Low/Medium (120 enemies) and High (`--cap 80`) with `?fps=1`, and the host on Low while serving 8 clients.

10. **No `no-new-privileges` in docker-compose.yml** (found 2026-11-02 on the first container runs): under snap Docker's AppArmor confinement it makes every exec in the container fail with "operation not permitted" (first `/sbin/docker-init`, then, with `init` removed, `docker-entrypoint.sh`). My first diagnosis blamed `init: true`; that was wrong. `init` stays out anyway (Colyseus handles SIGTERM/SIGINT itself and closes open match logs). The container still runs as `node` with **all capabilities dropped**, so setuid binaries cannot gain root powers. Docker config tests keep `no-new-privileges` out and `cap_drop: ALL` in. For audit 3.
11. `tools/docker-check.sh` runs the whole container check (start, `/api/lan`, host page, full run, LAN IP refused as host, log ownership, user, read-only filesystem) and prints PASS/FAIL per check. Run it with `bash tools/docker-check.sh` (asks for sudo once).
12. Docker check passed on 2026-11-02 (`bash tools/docker-check.sh`, all 8 checks).

### Open items from the first trial (2026-11-02, JCCJ: 1 player, no bots, trackpad)

- **Trackpad: no aiming or shooting while moving.** Likely cause: Ubuntu's "Disable touchpad while typing" (`org.gnome.desktop.peripherals.touchpad disable-while-typing` is `true` on the reference laptop). It blocks every trackpad event while a key is held, so the browser never sees them. The input code has no such rule. **To confirm** by turning the setting off. Options put to JCCJ: (1) a join-screen hint + game-night checklist + recommend a mouse; (2) a keyboard auto-fire toggle (new control: parked or 1f); (3) nothing in the game. Decision pending.

## 2026-11-02: Slice 1a.4 added (JCCJ)

- **Add-bots button on the host page** becomes slice **1a.4** of stage 1a, done in its own session (plan mode, tests first) **before security audit 1**, so the audit covers it. The server will start and stop bots itself through a new host-only command; details are planned in that session. Until then: `npm run bots -- --code ABCD --count N`.

## 2026-11-02: Trial game, JCCJ + 7 bots (log `logs/2026-11-02T17-42-22.873Z_LNQD.jsonl`)

- Players: J + Bot 1–7, normal rules. **7 min 0 s**, reached **wave 11** (waves 1–10 cleared), **885 kills**, **nobody downed**. Ended by the host going back to the lobby (`aborted`), not by a wipe.
- Server: tick p95 0.55 ms + patch 0.8 ms over the run (worst 10 s window 0.85 ms); worst tick 3.3 ms. Peak 47 enemies on the field, so the 120 cap was not reached. Heap 23–27 MB; RSS 111 → 122 MB.
- Bandwidth: 10.0 kB/s per client on average, peak 18.7 kB/s (lower than the load test's 43 kB/s at 120 enemies).
- Not yet the 10-minute acceptance run (7 minutes). Observations: 8 players clear waves 1–11 with no downs, so endless waves may be too easy for a full team early on; tuning is for 1e (and the bots do not dodge).

## 2026-11-03: Client performance in the match log, added to slice 1a.4 (JCCJ)

- Goal: one end-to-end game produces a log Claude can read for performance per **graphics tier**, **number of players** and **number of enemies**.
- Already logged (1a.3): every `perf` line (10 s) has players, enemies, bolts, server tick/patch p95, memory and kB/s per player.
- **New in 1a.4:** each client reports its tier, fps and 1% low (and canvas size) to the server; the server validates and rate-limits it (untrusted input) and logs it per player name in the `perf` line. Details (message shape, interval, limits) planned in the 1a.4 session, before security audit 1.

## 2026-11-03: Slice 1a.4 planning (answers from JCCJ)

1. **Bots run in one child process per room** (`child_process.fork`), started on the first "Add bot" and stopped when the room's last bot leaves. Bots connect over loopback like real players. Their CPU and memory stay out of the game server's tick and memory numbers in the match log.
2. **Host page controls**: "Add bot" (+1 per click) and "Remove bots" (all), lobby only; the existing Kick removes a single bot. Bots are marked "(bot)" in the host page's player list.
3. **Client perf reports every 10 s, always on during a run** (not only with `?fps=1`): average fps over those 10 s, 1% low over the same frames, tier, drawing-buffer width × height and pixel ratio. The server accepts at most one per 5 s per player, keeps the latest, and writes reports younger than 20 s into every `perf` line under `clients`, by name.
4. **The last host page leaving removes the room's bots** (any phase), so an abandoned room cannot keep playing by itself.

## 2026-11-03: Slice 1a.4 build notes

### How to run

- Host page: **Add bot** / **Remove bots** under Start and Back to lobby. `npm run bots -- --code ABCD` still works for bots on another machine or process.
- Every match log `perf` line now has `clients: { name: { tier, fps, low1, w, h, dpr } }`; the `start` line has `bots: [names]`.

### Versions (npm registry, 2026-11-03)

No new packages. `@colyseus/sdk` 0.18.9 (still the latest) moved from the server's dev dependencies to its dependencies, because the bot process needs it at runtime (also in Docker). `tsx` 4.23.15 (latest).

### Implementation choices (not in the brief; for review)

1. **Bot files moved** from `tools/bots/` to `server/src/bots/` (`bot.ts`, `brain.ts`), because the Docker image only ships `server/` and `shared/`. `tools/bots/run.ts` (the CLI), the load test and the tests import from there. `Bot` no longer imports the client's state type (it has a small local one).
2. **Bot tickets.** For each "Add bot" the room issues a one-time random ticket (`crypto.randomUUID()`, expires after 10 s, `TUNING.lobby.botTicketSec`) and hands it to its bot process over IPC. The bot joins with `{ name, botTicket }`, and `onAuth` uses the ticket up and marks that player `bot: true` at join time (no race with IPC). A wrong, reused, expired or non-string ticket means a normal join (no error). The bot's name comes from the ticket, not from the join options. This is a server-internal ticket, not a player credential; the "no tokens" rule for the host (loopback check) is unchanged.
3. **Seats for bots on their way are reserved**: a human join is refused as "full" when players + pending bot tickets reach 8. "Add bot" is refused at the same point.
4. **Bot names**: the lowest free `Bot N` (case-insensitive, so a human called "bot 1" pushes the bot to "Bot 2").
5. **`PlayerState.bot`** is synced (the host page shows "(bot)"). Being a bot gives no extra rights.
6. **Bot URL** comes from the server's own listen address: `http://127.0.0.1:<PORT>`, or `BIND_HOST` when that is a specific address (`createApp({ botUrl })` → `HoldRoom.botUrl`). Never from client options. Without a bot URL, "Add bot" is refused.
7. **Bot process lifecycle**: `fork(server/src/bots/process.ts, { cwd: server/, execArgv: ['--import', 'tsx'] })`. It stops when told to (last bot left, Remove bots, last host page left, room disposed; killed with SIGKILL if it hasn't exited after 2 s) and exits by itself when the IPC channel closes (server crash or shutdown). A bot that fails to join is reported back and logged on the server console.
8. **A bots-only run is allowed** (the host watches from the host page). "The room returns to the lobby when every player leaves" still counts bots as players.
9. **Perf report validation** (`sanitizePerfReport`, limits in `TUNING.log`): exact keys; tier `high`/`medium`/`low`; fps and 1% low finite, 0–1000; `w`, `h` whole pixels 1–16384; `dpr` 0.25–8. Values are rounded (fps 1 decimal, dpr 2). Reports from host pages, in the lobby, invalid ones and ones within 5 s of the last accepted one are rejected and counted.
10. **Client side** (`client/src/net/perfReport.ts`): frames longer than 1 s (`TUNING.log.maxFrameMs`: hidden tab or frozen machine) are skipped, not counted. **Changed 2026-11-09:** hidden tabs are now detected by the visibility event, and the cap is 10 s (see below). `FpsStats.low1()` takes an optional "newest N frames". The window restarts whenever the run is not running. The first `perf` line of a run (at 10 s) usually has no client reports yet: client and server both count 10 s from the start.
11. **Docker check**: `tools/docker-check.sh` now also adds a bot in the container (`tools/host-bot-check.ts`).

### Checks (2026-11-03)

- 305 unit + integration tests pass, 5 Playwright tests pass, lint and typecheck clean.
- After the tests no bot process was left running.
- A production server (`npm run server`) added a bot from a scripted host page (`tools/host-bot-check.ts`).
- `bash tools/docker-check.sh` needs sudo: **to run by JCCJ**. Done 2026-11-09: all checks passed (see below).

## 2026-11-07: Security audit 1 (JCCJ)

- **Deviation from the brief:** audit 1 runs as a cold subagent started from a Claude Code session, not as a separate fresh session. The subagent gets only the prompt from `audits/audit-1.md`, none of the session's conversation, plus one line on where to put scratch scripts, which ports to avoid and to stop what it starts. The report goes to `audits/audit-1-findings.md`.

### Fix decisions (JCCJ, 2026-11-07)

1. **Frame cap 240/s, hard.** Colyseus' `maxMessagesPerSecond` is set to `TUNING.net.maxFramesPerSec` (240). Every frame counts: PING, unknown requests, frames before the JOIN ack. A client over the cap is cut off at once (close 4002), and the log's `left` line gives the new reason **`protocol`**. Our token bucket (60/s, burst 120, kick 4020 after 3 s) stays for traffic under 240/s.
2. **Seat griefing fixed now**, not parked: at most **2 joins per LAN address per reservation window**, and the window is **5 s** (Colyseus default 15 s). The host laptop (loopback) is exempt, so bots and the host's own test tabs are not limited.

## 2026-11-08: Audit 1 fixes, build notes

### What changed

- **One LAN boundary in front of Colyseus:** `server/src/http/guard.ts` (`GuardedServer`, our own `http.Server` handed to `WebSocketTransport`). Colyseus answers `POST /matchmake/*` before Express and reads the body with no limit, so Express middleware could not guard it.
  - **F1:** on every request and WebSocket upgrade it deletes `x-real-ip`, `x-forwarded-for` and `x-client-ip`. There is no proxy, so these are always forged, and Colyseus then falls back to the real socket address for `context.ip`.
  - **F2:** the only write route is `POST /matchmake/<method>/<room>` with method `create` (host laptop only) or `joinById`. Any other spelling gets 404, other matchmaking methods (`join`, `joinOrCreate`, `reconnect`…) 403, and other HTTP write methods 405. The body must declare its length: missing or chunked gets 411, over 16 KB gets 413, and the guard closes the connection without reading the body. Pure rule: `matchmakeGate` in `shared/rules/validation.ts`.
  - **Seat griefing:** `ReservationLimiter` (same file) returns 429 with `JOIN_ERRORS.tooManyJoins`. The join screen shows that text as an "unknown" failure without auto-retry.
- **F3 + F4:** `HoldRoom.maxMessagesPerSecond = 240` and `seatReservationTimeout = 5`. A forced close (4002) is logged as `protocol`.
- **F5:** the name filter also strips the Unicode categories Zl and Zp (U+2028, U+2029). U+0085 was already stripped as a control character.
- **For 1f:** reconnect will need `reconnect` added to the allowed matchmaking methods in `matchmakeGate`.
- **Test-only option** `createApp({ lanClients: true })`: the guard treats every caller as a LAN laptop, so the LAN rules can be tested from loopback. It is never set in production.
- **Changed existing test:** `tests/integration/network.test.ts`. The 1,000-messages-in-one-second case now expects the frame-cap cut-off (4002). A new 150/s sustained flood checks drops and the 4020 kick after about 3 s.
- `ws` 8.22.1 and `@types/ws` 8.18.2 (latest, npm registry 2026-11-07) are now declared root dev dependencies, for the raw-socket regression tests. They were already installed through Colyseus.

### Checks (2026-11-08)

- Regression tests in `tests/regression/`: `host-spoof`, `matchmake-gate`, `matchmake-lan`, `frame-flood`, `name-separators`. They were written first and seen failing.
- All unit, integration and regression tests pass, along with 5 Playwright tests, lint and typecheck.
- **Audit scripts re-run** against a production server from the laptop's LAN address (192.168.1.11):
  - spoofed host refused on every header
  - 0 rooms from a 20 s create flood (67,802 refused), RSS flat at about 119 MB
  - 16 MB and 128 MB bodies dropped unread
  - 3rd seat reservation refused (429)
  - every flooded frame type closed in about 80 ms
  - the half-joined 16 KB-reflection socket closed after 600 frames (RSS 130 → 154 MB at peak, was 133 → 856 MB)
  - no U+2028 in the log
  - The frame and log scripts ran from loopback, because the per-IP join cap now stops the scripts' many joins from one LAN address.

### Re-audit (2026-11-08, cold subagent, `audits/audit-1-recheck.md`): audit 1 not passed yet

- **Correction:** the build notes above claim F4 is fixed. **It isn't.** The 240/s cap only stops fast floods. At 200 frames/s, a client that never sends the JOIN ack still grows server memory by about 3 MB/s, without bound. `frame-flood.test.ts` only floods at 1,000/s, so it missed this. My check of the audit scripts had the same blind spot.
- Confirmed fixed: F1, F2 and F5. Partly fixed: F3 (the frames still skip the token bucket under the cap) and checklist 18.
- **New findings**, still to fix, each with a regression test first:
  - **R1 (high):** the half-joined reply queue and unbucketed frames under the cap (the earlier F3/F4).
  - **R2 (medium):** one LAN address can fill all 8 seats within about 15 s, because only join attempts are capped, not the seats it holds.
  - **R3 (low):** look-alike names skip the duplicate suffix. Blank-looking names are accepted, a lone surrogate is stored differently from how clients show it, and one character can carry hundreds of combining marks.
- For audit 3: Colyseus echoes any Origin and doesn't check Origin on WebSocket upgrades, so a web page in the host laptop's browser could act as host. Also the server binds to `0.0.0.0`, and `/api/lan` lists Docker bridge addresses.

### Open (found while re-testing, not an audit finding)

- A player named `__proto__` is missing from the `kBps` and `clients` maps of `perf` lines, because those are plain objects keyed by name. Not a security issue (nothing else is affected), but the log loses that player's numbers. Fixed 2026-11-09 with `Object.create(null)` maps (see below).

## 2026-11-08: Audit 1 fixes, round 2 (R1, R2, R3, O1)

### Decisions (JCCJ, 2026-11-08)

1. **One seat per LAN laptop** (`TUNING.lobby.maxSeatsPerAddress = 1`). The host laptop (loopback) is exempt, for bots and test tabs.
2. **A kicked LAN laptop waits 60 s** (`kickCooldownSec`) before it can rejoin. The host laptop is exempt.
3. **Look-alike names:** the duplicate check uses a skeleton (NFKC, lower case, invisible characters removed, plus a small map of about 40 Cyrillic/Greek letters that look Latin). The name shown stays exactly as typed.
4. **O1 fixed now:** a client with more than 1 MB unsent (`TUNING.net.maxSendBacklogBytes`) is dropped.

### What changed

- **R1, our own frame gate (`HoldRoom.gateFrame`):** every frame from every client goes through it before Colyseus sees it. It does three things, in order:
  - the hard cap of 240 frames/s, now counted by us and still closing with 4002;
  - a check on the frame type: only the frames our clients actually send are allowed, and anything else closes the client with 4002 (log reason `protocol`). While joining that is the JOIN_ROOM ack and LEAVE_ROOM; once joined, ROOM_DATA and LEAVE_ROOM. PING, ROOM_REQUEST, ROOM_DATA_BYTES and the input frames are refused, because our clients never send them (checked in `@colyseus/sdk`: we never call `room.ping()`);
  - the token bucket (60/s, 4020 kick after 3 s) for ROOM_DATA.

  The message handlers no longer call `guard()`, so no frame is counted twice. Colyseus' own `maxMessagesPerSecond` stays as a second cap.

- **The gate wraps a Colyseus internal:** `Room._onMessage`, which Colyseus binds per client right after `onJoin`. It's set in the `HoldRoom` constructor and typed through a cast. `tests/regression/half-join.test.ts` fails if a Colyseus upgrade changes this.
- **JOIN ack timeout:** a client that hasn't acknowledged JOIN within 5 s (`TUNING.lobby.joinAckSec`) is closed and its seat freed.
- **O1:** `dropStalledReaders()` runs on every room timestep and drops a client whose ws `bufferedAmount` is over 1 MB.
- **R2:**
  - `onAuth` returns the socket address (forged headers are already stripped by the guard). `onJoin` refuses a 2nd seat from one LAN address with `JOIN_ERRORS.oneSeat`.
  - A kick blocks the address for 60 s (`KickCooldown`), refused with `JOIN_ERRORS.kickedWait`.
  - Test hook: `HoldRoom.treatLoopbackAsLan`, set by `createApp({ lanClients: true })`, never in production.
  - The join screen shows both new messages, with no auto-retry.
- **Existing leak found and fixed:** `onJoin` used to create a client's stats entry before the "full" and "run in progress" checks, so every refused join left one entry behind. Entries are now made only for accepted joins.
- **R3 (`sanitizeName`, `uniqueName`):**
  - names must be well-formed (no lone surrogates) and are stored as NFC;
  - default-ignorable characters and U+2800 are stripped. ZWJ/ZWNJ are kept only between two kept characters; variation selectors and emoji tags only right after one;
  - at most 4 combining marks per character (`maxMarksPerGrapheme`), and at most 64 UTF-16 units per name (`maxNameUnits`);
  - `nameSkeleton` is exported for the duplicate check.
- **Changed existing test:** `tests/unit/shared/validation.test.ts`, emoji names. Twenty family emoji (11 UTF-16 units each) now stop at 5 because of the 64-unit cap, still never split. Twenty plain emoji still give 16.
- `tsconfig.json` and `client/tsconfig.json` `lib` moved from ES2023 to **ES2024**, for `String.prototype.isWellFormed`. It's in Node 22 and in current Chrome.
- **For 1f (reconnect):** a reconnecting player must be let back in by its own address while its old seat may still be held. The `reconnect` matchmaking method is also still refused by the guard.

### Checks (2026-11-08)

- New regression tests: `half-join`, `slow-reader`, `seat-squat`, `name-lookalikes`. They were written first and seen failing (23 failed).
- Now 372 unit + integration + regression tests pass, along with 5 Playwright tests, lint and typecheck.
- **Re-audit probes** against a production server on port 2671, from 192.168.1.11:
  - half-joined 15 KB requests at 200/s: closed after 2 frames, RSS +1 MB (was +123 MB in 40 s, never closed);
  - seat fill from one address: 1 seat held, and a real player still joined (was 8 seats in 15 s);
  - 200/s PING or unknown requests: closed at once (was never kicked); 150/s game messages: 4020 after 4.4 s;
  - names: the lone surrogate and joiner-only names refused, 900 marks cut to 4. `probe-names.mjs` itself doesn't parse (its special characters were mangled in the file), so `probe-names2.mjs` and the regression tests cover this;
  - stalled reader: the server closed the socket and RSS stayed flat (+0.9 MB in 60 s);
  - round 1's `t5_limits`, from loopback: every frame type closed, and the reflection socket closed after 200 frames with RSS flat.
- O1 was proven by the regression test (which fakes a backlog over 1 MB). A real stalled reader needs many minutes to fill 1 MB plus the kernel buffers, so it wasn't run live; either way the memory is bounded.
- **Parked for audit 3:** O2 (any web page in the host's own browser can connect as host: no Origin check), O3 (the server binds `0.0.0.0`), O4 (`/api/lan` lists Docker bridge addresses).

## 2026-11-08: Third cold re-audit (`audits/audit-1-recheck-2.md`)

- F1–F5, R1–R3 and O1 are all fixed (checked live, with floods both above and just under each limit). No high or medium findings.
- **New: N1 (low).** The look-alike check misses plain-letter tricks (`AIice` vs `Alice`, `A1ice`) and some other scripts.
- **JCCJ's decision:** commit round 2 now, then fix N1 in the next session, with a regression test written first. The default is the small ASCII pre-fold (I/1/| → l, 0 → o, rn → m) plus a few more scripts. Audit 1 stays open until N1 is fixed.
- The reviewer's observations P1–P9 are in the report. Still to decide: whether the 6–9 s "already in the game" message after a silent Wi-Fi drop (P5), and the stack trace logged for each malformed frame, go into the N1 session.

## 2026-11-09: Audit 1, N1 fix (+ P5 retry, P1 `__proto__`)

**JCCJ's decisions:**

- **N1:** a small hand-written fold, not a table generated from `confusables.txt`.
- **i, I, l, 1 and | all count as one letter.** Folding capital I to l alone would break the case-insensitive rule (`Ian` vs `ian`), because look-alike matching has to be all-or-nothing.
  - Accepted trade-off: names that differ only there meet (`Ian`/`lan`, `Eli`/`Ell`), as do `0`/`o`, `rn`/`m` and `vv`/`w` (`Arnie`/`Amie`).
  - The second player to join gets " 2"; nobody is refused.
- **P5:** "This laptop is already in the game" now auto-retries every `joinRetryMs` (5 s). After a silent Wi-Fi drop the old socket lingers 6–9 s, so the player is back by the second try. Proper reconnect is still 1f.
- **P6:** the stack trace per malformed frame stays as it is (bounded; quieting it would mean another Colyseus internal).
- **P1:** fixed in the same session.

**Changes:**

- `nameSkeleton` (`shared/rules/validation.ts`): NFKC, strip invisibles, lower case, then the `CONFUSABLE` map, then the pairs `rn` → m and `vv` → w. The map now covers:
  - ASCII i/1/| → l and 0 → o;
  - Cyrillic, Greek, Armenian, Latin small capitals, alpha and script g;
  - 26 Cherokee capitals, plus their lower-case forms.
- `nextBotName` uses the same skeleton, so a human named `Bot l` makes the next bot `Bot 2`, not `Bot 1 2`.
- `writePerf` builds `kBps` and `clients` as null-prototype maps.

**Checks:**

- 17 new test cases were written first and seen failing (15 failed).
- 389 tests pass, along with 5 Playwright tests, lint and typecheck.
- The re-audit's `t7-names.ts` and `t8-names-live.mjs` both pass. The live probe ran against a production server on port 2673 from 192.168.1.11 and 172.16.0.2: `AIice` joined as `AIice 2`.

**Still open (parked):**

- For audit 3: P2 (emoji tag characters as hidden text), P3 (a kicked address can still make HTTP reservations), P4 (per-address limits vs IP aliases), P7 (pin exact Colyseus versions?), P8 (no per-address connection cap).

## 2026-11-09: Perf reporter: tab visibility instead of the 1 s frame cutoff

- **Problem:** in the 2026-11-03 trial, JCCJ's client reports stopped at about 290 s. The reporter skipped every frame over 1 s as a stand-in for "hidden tab". A browser below 1 fps would therefore vanish from the log instead of showing up as slow.
- **JCCJ's decision:** detect a hidden tab with the `visibilitychange` event, and keep a 10 s cap as a safety net. A closed laptop lid doesn't always fire the event.
- **Changes:**
  - `PerfReporter.hidden()` skips the one gap frame after the tab was hidden; `client/src/game.ts` calls it on `visibilitychange`.
  - `TUNING.log.maxFrameMs` is now 10_000. Frames from 1 to 10 s now count in fps and the 1% low.
- **Checks:**
  - 4 new or changed reporter tests were written first and seen failing.
  - 392 tests pass, along with 5 Playwright tests, lint and typecheck.
  - Not checked by hand in a browser yet: switch tabs for about 20 s during a run, and the next `perf` line should still have the client's report. For the next playtest.

## 2026-11-09: Client fps check deferred to 1e (JCCJ)

- **Deviation from BRIEF.md** ("Performance budget": the check runs from 1a onward with the load test). The by-hand client fps check is no longer part of 1a. It covers Low/Medium at 120 enemies (targets 60 / 45 fps), High at 80 enemies (`--cap 80`), and the host on Low while serving 8 clients.
- **When:** stage 1e. The real enemy mix (rusher, brute, ranged, boss) and the 10-wave tuning arrive there, and that horde is the main cost. Add it to the 1e plan.
- **Unchanged:** the 1a server load test (8 bots, 120 enemies, 15 min) passed on 2026-11-02. Client fps reports keep flowing into the match logs, so playtests still record real fps meanwhile.

## 2026-11-09: Docker check passed (JCCJ)

- **First run, invalid:** JCCJ's own terminal server was still holding port 2567. With host networking, the container's server couldn't bind, so "server started in the container" failed.
  - The other HTTP checks passed only because the terminal server answered them. The log file permissions show it: `CNRQ` and `FBQD` are `-rw-rw-r--` (terminal server), not `-rw-r--r--` (container).
- **Second run, with 2567 free:** all checks passed, the bot check included. The new log `2026-11-09T12-42-59.631Z_SYNY.jsonl` has the container's permissions.
- **Port guard (JCCJ: yes):** `docker-check.sh` now stops with "FAIL port 2567 is already in use", right after `docker compose down`, so its own container never trips it.
  - `CHECK_PORT` overrides the port for the script's test only.
  - `tests/unit/tools/docker.test.ts` runs the script with a fake `sudo` that records its calls. A busy port must stop the script before `docker compose up`; a free port must reach it.
- **The `NJGF` run** (J + Bot 1, 174 s): J's client reports are missing until 150 s. JCCJ confirmed the tab was in the background then, so this is expected, not a reporter bug.

## 2026-11-09: Remaining 1a items deferred to 1f; 1a closed (JCCJ)

- **Deviation from BRIEF.md.** The 1a acceptance criteria and milestone aren't fully met when 1a closes. JCCJ deferred these three items to **stage 1f** (game-night readiness):
  1. **The 10-minute acceptance run:** 1 player + 7 bots, 10 minutes of play with no visible desync. The best so far is 7 minutes (2026-11-03).
  2. **The game-night playtest:** the 1a milestone.
  3. **The trackpad decision:** confirm the "disable touchpad while typing" cause, then choose between a hint/checklist, an auto-fire toggle, or nothing.
- Also deferred, earlier today: the client fps check, to 1e.
- **Done in 1a:** every 1a test passes (394 unit, integration and regression tests, plus 5 Playwright), lint is clean, and security audit 1 passed. The server load test passed, and the Docker check passed.
- **For the 1f plan:** include all three items above. The 1c playtest still happens as the brief says, and it can give early answers on desync and the trackpad.
- Stage 1b starts in a new session: "Read CLAUDE.md and NOTES.md. We are doing stage 1b."

## 2026-11-09: Stage 1b planning (answers from JCCJ)

### Process

- Stage 1b is split into two slices, one per session:
  - **1b.1:** `shared/` (kits, tuning, ability rules, validation) and the server (pick, casts, zones, status effects, melee). Headless.
  - **1b.2:** assets (Knight, Rogue, Rogue_Hooded + clips), client hero visuals, Tide recolour, HUD ability slots, lobby pick UI, prediction of Flame step / Gust dash, Playwright.

### Kits (the definition `shared/heroes.ts` must match)

- **Base stats and basic attacks are the look-test values.** All heroes have 400 HP, radius 0.5.
  - Ember (fire, ranged): speed 5.4; Fire bolt 20 dmg every 0.55 s, range 12, 22 m/s.
  - Bastion (earth, melee): speed 4.8; Sword chop 34 dmg every 0.8 s, reach 2.4 m.
  - Tide (water, ranged): speed 5.2; Water bolt 16 dmg every 0.6 s, range 12, 22 m/s.
  - Gale (air, melee): speed 6.4; Twin daggers 22 dmg every 0.45 s, reach 2.2 m.
- **Melee hits** every risen enemy within reach + 0.4 m inside a front arc (cos ≥ 0.35) and knocks it back at 2.5 m/s, decaying. Aim assist picks the facing within reach + 1.2 m.
  - Deviation from the look test: no 0.25 m lunge (it would fight own-hero prediction), and the hit lands instantly instead of after 0.2 s.
- **Q zones** (JCCJ: distinct per element). Every zone has radius 3 m, lasts 4.2 s, cast range 11 m (clamped), cooldown 5 s.
  - Fire zone: 14 dmg/s.
  - Quake slam: 30 dmg on cast + 1 s stun, then 6 dmg/s.
  - Tidal pool: 6 dmg/s + 50% slow.
  - Cyclone: 6 dmg/s + pull to the centre at 2 m/s.
- **E utilities and passives** (proposed by Claude, approved by JCCJ):
  - Ember. E **Flame step**: blink up to 6 m toward the aim, cd 8 s. Passive **Kindle**: bolt hits burn 4 dmg/s for 2 s (a new hit refreshes; no stacking).
  - Bastion. E **Stone skin**: −60% damage taken for 4 s, and enemies within 6 m target him for 4 s; cd 14 s. Passive **Steadfast**: −15% damage taken, always (with Stone skin: ×0.85 × 0.4).
  - Tide. E **Mending wave**: heals Tide and standing allies within 6 m for 30% of max HP, capped at max; doesn't revive; cd 16 s. Passive **Undertow**: bolt hits slow 30% for 1.5 s.
  - Gale. E **Gust dash**: 7 m toward the aim over 0.25 s; enemies along the path are knocked 3 m aside; cd 7 s. Passive **Tailwind**: every 4th swing that hits deals ×2 to everything it hits.

### Other answers

- **Props:** Bastion keeps 1H_Sword + Round_Shield; Tide keeps 1H_Crossbow; Gale keeps Knife + Knife_Offhand. Everything else is dropped.
- **1–4 debug hero switch:** only with `?debug=1`.
- **XP scaling (JCCJ idea):** parked as "In-run XP that levels up Q, E and passive". Light hook in 1b: every kit number is read through `heroKit(id, level)`, and level is always 1. No XP, no level-ups, no UI.

### Defaults approved with the 1b plan

1. `InputMessage` gains `cast: 'none' | 'q' | 'e'` (an ability id) and `qHeld: boolean`.
   - The client sends `cast: 'q'` in the one input after Q is released.
   - The server latches the cast until the next tick, so a cast between ticks isn't lost.
2. A refused cast is dropped, not queued (downed, dead, on cooldown, stale input). A refused cast doesn't start a cooldown.
3. **The debug switch is double-gated:** `?debug=1` on the client, and the server accepts `debugHero` only with `CROSSFIRE_DEBUG=1` (`npm run dev` sets it; Docker never does).
   - It keeps the HP fraction and the remaining Q/E cooldowns.
   - Standing heroes only, at most one switch per second.
4. **Hero pick:** `pick { hero }` in the lobby only, validated as an own key of the hero table. Allowed whether or not the player is ready. Default Ember.
5. **Duplicates stack.** Same-element zones each apply their damage; slows take the strongest; stuns refresh. A second Bastion's taunt takes over (the latest caster wins). Two Tides' heals each apply, each capped.
6. Zones and status effects skip enemies that are still rising. Kills by zones and burns count in `kills`.
7. **Deviation:** `server/src/sim/zones.ts` is listed under 1c in BRIEF.md; it's created in 1b because Q needs it. Combos are added to it in 1c.
8. Bots stay Ember and don't use Q or E in 1b. Bot hero variety → 1e.
9. The match log's `start` line gains `heroes: { name: heroId }`. No cast events (combo events come in 1c).
10. Tide recolour (1b.2): a runtime material colour multiply of 0xa9c6ff on the whole model, as in the look test. KayKit uses one texture-atlas material, so the skin is tinted too.

## 2026-11-09: Slice 1b.1 build notes

### Versions

- No new packages. `@colyseus/schema` is installed at 5.0.43; the registry has 5.0.45 (patch). Not upgraded in this slice. `t.uint8()`, `t.boolean()` and `t.map()` were checked in the installed package.

### Implementation choices (not in the brief; for review)

1. **Order inside a tick.** For each hero: cooldowns tick down, then the latched cast (Q or E), then movement (or the dash), then the basic attack, then the ring drain. After the heroes: zones, enemies, burns, bolts. So a zone acts on its own cast tick, and Gust dash ignores move input from its first tick.
2. **Quake slam's stun cancels a swing in wind-up.** A stunned minion neither walks nor starts a swing.
3. **Gale passes through enemies while dashing** (not solid to them during the dash). The knockback check is swept along each tick's path, so a fast dash can't skip an enemy. Each dash knocks an enemy once; the dash has its own id.
4. **Knockback** is a decaying velocity (rate `knockbackDecayPerSec` 4/s). Gust dash sets the start speed so the slide is exactly 3 m. A melee hit adds 2.5 m/s (look test), about 0.7 m of slide.
5. **Slows** have two slots, zone and bolt; the strongest active one wins. A Tidal pool's slow lasts 0.2 s after the minion leaves the pool (`slowHoldSec`).
6. **Taunt** only catches risen enemies. It ends early if Bastion stops standing.
7. **Kindle and Undertow** apply only when the bolt doesn't kill. A bolt carries its owner's hero at fire time.
8. **A full zone pool** (32) refuses the cast without starting the cooldown. It can't fill in normal play: at most 8 zones are alive.
9. **Synced state additions:**
   - `PlayerState.hero`;
   - `HeroState`: `hero`, `qCd`, `eCd`, `stoneSkin`, `dashing`, `act` + `actSeq` (`dashing` wasn't in the plan; it's for the 1b.2 dash visual);
   - `ZoneState` (x, z, element, remaining);
   - `EnemyState.fx`, a bitmask of slowed, stunned and burning (`ENEMY_FX`).
10. **Client until 1b.2:** it sends `cast: 'none'`, `qHeld: false` and still predicts with Ember's speed. That's fine while the join screen has no hero pick: everyone is Ember.
11. `npm run dev` now sets `CROSSFIRE_DEBUG=1`. The production server and Docker don't.
12. **The XP idea** is now one line in BRIEF.md's parked list (the brief's rule: new ideas go to the parked list).

### Changed existing tests (mechanical)

- `TUNING.ember` → `TUNING.heroes.ember` everywhere.
- The `input()` helpers (unit, edge, integration) and the validation fixture gain `cast` and `qHeld`.
- The match log tests' `start` lines gain `heroes`.

### Test-first record

- 69 new tests were written first and seen failing: `abilities`, `heroes` (sim), validation additions, `integration/heroes`.
- **Corrected before any code:** I re-checked my own test arithmetic before writing code and found these mistakes:
  - **Tick counting.** A zone also acts on its cast tick; Q spam over 30 s gives ⌈30/cd⌉ casts.
  - **Ring drain.** The quiet test world turns drain off, so blinking or dashing heroes don't lose HP outside the ring.
  - **Melee tests.** They pin their target, because knockback pushes it out of reach.
  - **Two tests that measured nothing:**
    - Kindle refresh: the old test was trivially true. It now checks that every burn-only tick deals 4/s × dt.
    - "Cast before going down": with one hero it ended the run instead. It now has a second hero.
  - **The Undertow-in-pool test** cast from out of range. Its caster now stands within 11 m.
- **Fixed after the first run:** two test setups. The Cyclone test moved its caster 20 m away before casting. The Gust dash test put the "off-path" minion exactly where the knocked one slides to.

### Checks (2026-11-09)

- **Tests:** 499 unit, integration and regression tests pass (394 before). Lint and typecheck are clean. Playwright was not run (no client change beyond the two input keys); it runs in 1b.2.
- **Server smoke run** (`tools/smoke-server.ts`): lobby → running → ended after 17.9 s.
- **Load test,** 2 minutes, 8 bots, 120 enemies: PASSED.
  - Tick p95 0.95 ms + patch 0.9 ms = **1.9 ms** (1a: 1.7 ms).
  - Bandwidth **42.7 kB/s** per client (1a: 42.5).
  - 810 kills (6.8/s against 4.8/s in the 1a run; Kindle's burns add damage).

## 2026-11-09: Slice 1b.2 planning (answers from JCCJ)

1. **Bolt colour: the element is synced.** `BoltState` gains `element` (`t.uint8()`, an index into `ELEMENT_IDS` in `shared/heroes.ts`), set from the bolt owner's hero at fire time. **Deviation:** a small server change in a client slice.
2. **Clips that fit each weapon:**
   - Ember: attack Spellcast_Shoot, Q Spellcast_Raise, E none (the blink is instant).
   - Tide: attack 1H_Ranged_Shoot (crossbow), Q Spellcast_Raise, E Spellcast_Raise.
   - Bastion: attack 1H_Melee_Attack_Chop, Q 1H_Melee_Attack_Chop, E Block.
   - Gale: attack Dualwield_Melee_Attack_Chop, Q 1H_Melee_Attack_Chop, E Dodge_Forward.
   - This differs from the look test, which used Spellcast_Shoot for Tide and the 1H chop for Gale.
3. **Simple placeholder effects** (the real art is 1g): an element aura under each hero, zone discs in the element colour (look-test zone texture), the Q preview while Q is held, E effects (blink puffs, a stone shell while Stone skin is up, a heal ring, a dash trail) and small status glows on enemies (burning, slowed, stunned).
4. **Lobby pick: four hero cards** (name, element and style, the Click/Q/E/passive names). Click to pick; the pick is highlighted. The lobby's player list shows each player's hero.

### Defaults approved with the 1b.2 plan

1. **Body parts stay, only props are dropped** (as with the Mage's hat and cape):
   - Bastion keeps Knight_Helmet and Knight_Cape and drops 1H_Sword_Offhand, 2H_Sword and the Badge, Rectangle and Spike shields.
   - Tide drops Knife, Knife_Offhand, 2H_Crossbow and Throwable.
   - Gale drops 1H_Crossbow, 2H_Crossbow and Throwable.
2. **Heights** (look test): Knight 1.85 m, Rogue and Rogue_Hooded 1.8 m. All four hero files share one 41-bone rig and the same 76 clips (checked), so one `hero-anims.glb` serves them all.
3. **Tide tint:** Rogue_Hooded's own material colour is multiplied by 0xa9c6ff once at load.
4. **Q and E keys:**
   - Q release sends `cast: 'q'` in the next input; `qHeld` mirrors the key.
   - An E press (not a held repeat) sends `cast: 'e'` once.
   - Presses between two sends are latched. Q and E in the same tick go out as q, then e in the next input.
   - A window blur or hidden tab while Q is held cancels the cast. Casts are sent only while standing.
5. **E is sent only when the predictor thinks it's ready**, so a press during cooldown is never predicted and snapped back. Q isn't predicted; it is always sent and the server decides.
6. **Another player's Flame step** clears that hero's snapshot buffer, so it jumps instead of sliding 6 m.
7. **Attack, Q and E animations** come from the synced `act`/`actSeq`; they replace the "nearest hero to a new bolt" guess.
8. **Reticle range and the client aim-assist ring per hero**: bolt range for ranged heroes; reach + `TUNING.melee.assistExtra` for melee (the server's rule).
9. **HUD:** Click, Q and E slots with a cooldown overlay; the Q slot is armed (gold) while Q is held; the passive name is a small line under the hero name; the help panel gains Q and E, and "1–4 switch hero" only with `?debug=1`.
10. **Playwright's server runs with `CROSSFIRE_DEBUG=1`** so the e2e test can try the debug switch. Production and Docker still never set it.
11. **Element colours** (look test: fire 0xff6a2b, earth 0xc9934a, water 0x3fa7ff, air 0xbdf5ff) live in `shared/heroes.ts`: art, not tuning.
12. Not in 1b.2: picks on the host page; bot hero variety (1e).

## 2026-11-10: Slice 1b.2 build notes

### Versions

- No new packages. three 0.187.0 is still the latest (npm registry). `AnimationAction`, `SkeletonUtils.clone` and `Color.multiply` were checked in the installed types, and `t.uint8()` in the installed `@colyseus/schema` 5.0.43.

### Implementation choices (not in the brief; for review)

1. **Assets.**
   - `tools/assets.mjs` writes `Knight.glb` (108 KB), `Rogue_Hooded.glb` (92 KB) and `Rogue.glb` (93 KB). Each is one skinned mesh with one draw call.
   - `hero-anims.glb` grows from 8 clips to 14 (313 KB → 493 KB). The whole model set is 1.28 MB (the test's limit is 2 MB).
   - Each character job names its body-part prefix (`Mage_`, `Knight_`, `Rogue_`), and the manifest records `keptProps`. The asset test checks those against `HEROES[id].props`.
2. **`MODEL_FILES.heroes`** (per hero, derived from `HEROES[id].model`) replaces `MODEL_FILES.hero`. `HERO_ANIM` in `client/src/render/clips.ts` holds each hero's attack, Q and E clips.
3. **Shared rule `assistRange(hero)`** (`shared/rules/abilities.ts`) gives bolt range for ranged heroes and reach + `melee.assistExtra` for melee. The server's `basicAttack` now uses it too, so the reticle and the server can't drift apart. Server behaviour is unchanged.
4. **Predictor.**
   - `setHero(id)` sets the hero.
   - `applyInput(seq, moveX, moveZ, cast, aimX, aimZ)` mirrors the server's tick order: E cooldown, then the cast, then a dash or a walk.
   - Each pending input stores its mode (walk, blink or dash tick, with the dash direction). On replay, a blink is recomputed from the replayed position; a dash tick reuses its stored direction (the server doesn't sync dash time or direction).
   - `reconcile(…, eCd)` rebuilds the cooldown estimate from the server's `eCd` plus the pending inputs, and `eReady()` looks one tick ahead.
   - `tests/integration/prediction-parity.test.ts` drives the real `World` and a `Predictor` with the same inputs. Positions agree to 1e-6 on every tick for all four heroes.
5. **Input.**
   - `CastLatch` (`client/src/input/cast.ts`): an E press is accepted once, until E is released (a key repeat without the repeat flag doesn't count).
   - A press while not standing is dropped, not saved.
   - Q and E are game keys now, so the browser default is prevented.
6. **Effects (placeholders).**
   - Element aura under each standing hero; a Stone skin shell (an earth-coloured translucent cylinder); a Gust dash trail (3 air glows behind the hero).
   - Ground pulses (pool of 24): Flame step (fire, at both ends), Mending wave (water, out to 6 m), Stone skin (earth, out to the 6 m taunt radius; not in the plan, added as a cue for the taunt).
   - Zone discs are pooled (cap 32). They fade in over 0.25 s and out over the last 0.5 s, counting down between patches.
   - Enemy status glow: one sprite above the head, priority stunned (yellow 0xffe14a) > burning (fire) > slowed (water).
7. **Animation speeds:**
   - Attacks play at `max(2 for ranged / 1.8 for melee, clip ÷ attack interval)`, so fast attackers (Gale, 0.45 s) restart cleanly.
   - Q plays at 1.6× (look test).
   - The Gust dash clip is squeezed into the 0.25 s dash.
8. **Another hero's Flame step** clears its snapshot buffer, so it jumps instead of sliding 6 m (approved default 6). The "nearest hero to a new bolt" cast-animation guess is gone; `act`/`actSeq` drives every animation.
9. **HUD.**
   - The Q and E slots get a cooldown shade (look-test style) and `data-cooling` for the tests. The Q slot is `armed` while Q is held.
   - "Passive: …" sits under the HP text.
   - **Layout fix found in the screenshots:** below 1180 px wide, the help panel covered the E slot. It now moves up above the bar (`bottom: 104px`), and it's still hidden below 760 px.
10. **Lobby.** Four `button` cards (`#pick-<hero>`, `aria-pressed`), each with an element-colour left border. The player list shows each player's hero. All text still goes through `textContent`.
11. **Debug view** (read-only, for Playwright) gains `me.hero`, `me.eCd`, `zones` and `qPreview`.

### Changed existing tests (mechanical)

- `tests/unit/tools/assets.test.ts`: checks all four hero files where it checked only `MODEL_FILES.hero` (now `MODEL_FILES.heroes.ember`).
- The old prediction tests are unchanged (the new `applyInput` arguments are optional).

### Test-first record

- **Written first and seen failing:**
  - 17 failed: 13 prediction tests, 4 parity tests (one per hero), and 1 bolt-element test.
  - Three whole test files couldn't load (`client/heroes`, the input additions, the asset test), because the modules they import didn't exist yet.
- **Corrected before any code:** the blink-replay test expected x = 9.7 after the blink. A blink from x = 9.7 toward (10, 30) moves x a little too, so the test now computes the expected point with `blinkTarget`.
- **Fixed while writing:** the bolt-element integration test sent inputs every 10 ms, above the 60/s rate limit. It now sends at 20 Hz.
- **Playwright, first run:** "with ?debug=1, key 3 switches to Tide" failed (still Ember after 1 s).
  - A real server switched correctly when driven by the SDK.
  - The same browser steps, run alone, worked and showed the debug frame being sent.
  - Cause: load. Earlier tests' pages were still open and rendering, and the poll allowed only 1 s.
  - Fix: `heroes.spec.ts` closes its pages after each test, and the poll allows 3 s. The full suite then passed twice in a row.

### Checks (2026-11-10)

- **Tests:** 537 unit, integration and regression tests pass (499 before) and 9 Playwright tests pass (4 new). Lint and typecheck are clean.
- **Server smoke run** (port 2599): lobby → running → ended after 18.0 s.
- **Load test,** 2 minutes, 8 bots, 120 enemies: PASSED. Tick 1 ms + patch 0.9 ms = **1.9 ms**, and **42.7 kB/s** per client (same as 1b.1), so the bolt `element` byte doesn't show.
- **Screenshots** (headless Chrome, scripted):
  - the lobby cards and the HUD for each hero;
  - Tidal pool and Quake slam discs, plus a Cyclone disc, in their element colours;
  - the Mending wave ring, Ember's blink, and Bastion's stone shell;
  - Gale's dash, measured at exactly 7.00 m.

### For JCCJ's review

- **Tide's tint looks teal-green, not blue.** A light-blue multiply over the Rogue's green atlas comes out teal. It is the look-test method (default 10 of the 1b plan), but the result doesn't read as "water" on screen. Options: a stronger tint, a tint on the cloth only (needs a texture or mask pass), or the paid KayKit model (parked). Not changed: your call.
- **Play it by hand** (`npm run dev`, one tab per hero) and check how it feels: the dash and blink, the zone readability, and the animation speeds.

## 2026-11-10: After slice 1b.2 (JCCJ)

- **Docker check passed** (`bash tools/docker-check.sh`, all checks), after the 1b.2 commit. Its scripted run is `logs/2026-11-09T19-19-09.902Z_CGVN.jsonl`, with the container's file permissions.
- **JCCJ's `npm run dev` game** (`QKLC`): J + 3 bots, all Ember, 5 min 42 s, wave 9, 381 kills, wiped.
  - Server tick p95 at most 0.65 ms + patch 0.95 ms; at most 17.6 kB/s per client.
  - The client ran at about 60 fps on High, except 80–100 s (18 and 4 fps, frames up to about 10 s) and 320–340 s (1% low 5.8 fps). No client reports 230–310 s (tab most likely in the background).
- **Closed: the lobby showed no hero cards in JCCJ's game.** After a hard reload (Ctrl+Shift+R) on `localhost:5173`, the four cards appear (JCCJ, 2026-11-10). The cause was a browser tab still running a pre-1b.2 page. Not a game bug, so no regression test. Game-night tip: after an update, players reload the page.

## 2026-11-10: Pause added as slice 1b.3 (JCCJ)

- **New feature, not in BRIEF.md: pause the run.** It becomes slice **1b.3**, built in its own session (plan mode, tests first) right after 1b.2 and before stage 1c, so it's ready for the 1c game-night playtest.
- **Deviation from the brief's rule** ("adding to Phase 1 means removing something of equal size"): JCCJ judged pause too small to need a trade. **Nothing leaves Phase 1.**
- **Decisions:**
  1. **Who:** any player can pause, with **Esc**. Only the **host page** can resume, with a Resume button checked on the server like Start and Back to lobby.
  2. **What freezes: everything.**
     - the simulation (enemies, bolts, zones);
     - cooldowns, the ring drain and regeneration;
     - bleed-out and revive timers, and the wave and break timers.
     
     Inputs are ignored while paused. The match log records pause and resume, and the run time excludes the pause.
  3. **Esc in fullscreen** also leaves fullscreen (the browser's own rule). Accepted.
- **Still to settle in the 1b.3 planning session:**
  - what players and the host page show while paused (banner text, who paused);
  - a limit on pause spam (one player pausing again and again);
  - pausing during a wave break, or while the pausing player is downed or dead;
  - what bots do;
  - the perf reporter (count a pause like a hidden tab?) and the `perf` lines during a pause;
  - whether a player leaving or being kicked while paused changes anything.
- **The "no hero cards" report is settled** (a stale browser tab, see above): nothing blocks 1b.3.
