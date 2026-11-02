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
