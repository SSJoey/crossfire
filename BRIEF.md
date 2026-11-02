# Crossfire: Phase 1 build brief

Nov 2, 2026 · @JCCJ

## Goal and scope

Phase 1 is done when up to 8 people on laptops on one Wi-Fi finish a full run of about 15 minutes at a real game night, and at least one person asks to play again.

The game is a browser-based, LAN-only co-op. Each player controls a hero defending a fixed hold point against escalating waves of skeletons. The hook is cross-player elemental combos: when two different players drop zones of different elements on the same spot within 1.6 seconds, the zones fuse into a combo whose effect comes from the element pair and whose shape comes from the two heroes' attack styles.

Visual reference: the [look test](https://claude.ai/artifact/24P44a19RYvmoSUd6PygJv). It fixes the art direction (KayKit), the camera angle, the hold point, the range ring, zone and combo effects, and the HUD layout. It is a prototype, not code to copy.

**How to use this brief:** paste the CLAUDE.md block into the repo root, then run one stage per Claude Code session in order. The build starts when JCCJ says so; there is no calendar date.

**Phase 1 includes**

1. LAN lobby: the host laptop runs the server; players join by QR code or link; 1 to 8 players; late joiners wait for the next run.
2. Four heroes, one per element, duplicates allowed: Ember (fire, ranged), Bastion (earth, melee), Tide (water, ranged), Gale (air, melee). Each has a basic attack, a Q elemental zone, an E utility and a passive.
3. A hold point with a soft-edge range: outside the ring, heroes lose health.
4. Ten waves that scale with player count, three skeleton types (rusher, brute, ranged), a boss on wave 10, and a spawn telegraph.
5. Downed and revive: about 20 seconds of bleed-out, hold F for 3 seconds to revive; the dead spectate with one support flare per wave and return at the intermission.
6. Power-ups: four temporary modern weapons that spawn at or past the edge (gun, mortar strike, steroids, flak vest), plus one permanent passive picked at each intermission.
7. The combo hook: 6 element-pair effects in 3 shapes, with a combo-ready cue on the Q slot.

**Out of scope for Phase 1**

- Mobile and touch controls
- Internet play, accounts, matchmaking
- Meta progression between runs
- PvP
- More than 8 players
- Saves, a map editor, a second map
- Music and polished audio (placeholder sound effects only)
- Anything on the parked list at the end of this brief

## CLAUDE.md

Paste this into `CLAUDE.md` at the repo root before the first session. Claude Code reads it at the start of every session.

```markdown
# Crossfire

Browser LAN co-op: up to 8 heroes defend a hold point against skeleton waves.
The hook: two different players' elemental zones overlapping within 1.6 s fuse into a combo.
Full brief: BRIEF.md in this repo (the master copy). Visual reference: the look test artifact.
If this file and the brief disagree, stop and ask.

## Non-negotiable rules
- Follow the current stage exactly. Do not build later-stage features early.
- Never assume. If something is not specified, ask, then record the answer in NOTES.md.
- Write the stage's tests BEFORE its code. A stage is done only when all its tests pass and lint is clean.
- Start every session in plan mode. Show the plan, wait for approval, then code.
- One stage per session. Stop at the end of the stage for review.
- Record every decision and every deviation from the brief in NOTES.md, with the date.
- Check current versions and APIs in each library's docs before writing code. Do not rely on memory.

## Stack
- Client: three.js + TypeScript, bundled with Vite.
- Server: Node.js + Colyseus (rooms, join codes, state sync, reconnection) + TypeScript.
- Shared: a `shared/` package of types, constants and pure game rules used by both sides.
- Tests: Vitest (unit + integration), Playwright (browser smoke), headless bot clients (load).
- Lint: ESLint + Prettier from day one.
- Runtime: Docker Compose on Ubuntu, LAN only.

## Architecture rules
- The server is authoritative. Clients send input only: move vector, aim point, button states, ability ids.
- The server runs the simulation at a fixed 20 Hz tick (starting value) and broadcasts state.
- Clients predict their OWN hero's movement and facing, then reconcile with the server. Everything else interpolates between snapshots.
- Game rules (damage, scaling, combos, revive, cooldowns, validation) are pure functions in `shared/rules/`, unit-tested without a browser.
- Every tunable number lives in `shared/tuning.ts`. They are starting values for playtesting.
- Simple custom physics on the XZ plane: heroes and enemies are circles, projectiles are points. No physics engine.
- Reuse objects: enemies, projectiles and effects come from pools. No per-frame allocation in hot loops.
- Each match writes one JSON Lines event log to `logs/` on the host (names only, no other personal data).

## Art and assets
- Heroes: KayKit Adventurers (CC0). Ember = Mage, Bastion = Knight, Tide = Rogue_Hooded recoloured blue, Gale = Rogue.
- Enemies: KayKit Skeletons (CC0): Minion = rusher, Warrior = brute, Mage or Rogue = ranged, scaled-up Warrior = boss.
- `tools/assets.mjs` slims the models: strip unused clips, keep one shared animation set per rig, compress geometry.
- Visual identity: body = model, element = aura and effects colour, player = ground ring colour + name tag.
- Three graphics tiers: High (shadows + bloom), Medium (shadows), Low (no shadows, pixel ratio 1).

## Repo layout
client/src/   main.ts, render/, net/, input/, hud/
server/src/   index.ts, rooms/HoldRoom.ts, sim/, log/
shared/       types.ts, tuning.ts, heroes.ts, rules/
tools/        assets.mjs, bots/ (headless clients), load-test.ts
tests/        unit/, integration/, e2e/, regression/
assets/       source KayKit files (not served)

## Controls (laptop)
WASD move, mouse aims on the ground, left click basic attack (hold to repeat),
hold Q to preview the zone and release to cast, E utility, hold F to revive, 1 to 4 debug hero switch.
Aim assist is on by default: basic attacks snap to the nearest enemy in a cone around the aim direction.

## Working style
- Explain each setup step in one or two plain sentences.
- Keep changes small and reviewable. Commit at the end of each green stage.
```

## Stages

Seven stages, run in order. Stage 1a must be playable at a real game night on its own. There are playtests after 1a and after 1c, and a stage never starts while the previous one has a failing test.

| Stage | Goal | Playtest or audit after |
| --- | --- | --- |
| 1a | Playable core on the LAN | Game-night playtest + security audit 1 |
| 1b | Four heroes with full kits | None |
| 1c | The combo hook | Game-night playtest |
| 1d | Power-ups and passive picks | Security audit 2 |
| 1e | The full 10-wave run with a boss | None |
| 1f | Game-night readiness | None |
| 1g | Art pass | Security audit 3 before any game night outside home |

### 1a: Playable core

**Goal:** a group can join from their laptops and survive endless waves together with one hero.

**Files touched:** project setup and `docker-compose.yml`; `server/src/rooms/HoldRoom.ts`, `server/src/sim/` (tick, heroes, enemies, waves), `server/src/log/`; `shared/` (types, tuning, rules for damage, scaling, revive, validation); `client/src/` (scene, units, net with prediction, input and aim, HUD basics); `tools/assets.mjs`, `tools/bots/`, `tools/load-test.ts`.

**Includes:**

- Host page with room code, link and QR code; a join screen (name, ready); the host starts the run; a 9th player is refused with a clear message.
- A "can't reach host" message on the join screen, and a live player count on the host page.
- The KayKit pipeline: Ember for everyone, Skeleton Minion as the only enemy.
- The hold point, the range ring and the soft-edge health drain.
- Basic attack with aim reticle, aim line and aim assist; endless waves that scale with player count.
- Health, downed, bleed-out, revive with F, and an end screen when everyone is down.
- Client-side prediction for the player's own hero; three graphics tiers; the JSON Lines match log.

**Acceptance criteria:**

- 8 players (or 1 player + 7 headless bots) play a 10-minute run with no desync visible to the players.
- The performance budget is met on the reference laptop (see below).
- All 1a tests pass; security audit 1 passes.

**Tests that must pass:**

- Unit: damage and health never go below 0; wave scaling at 1, 4 and 8 players; bleed-out and revive timers; soft-edge drain.
- Edge: revive interrupted by the reviver going down; all heroes downed in the same tick; a hero exactly on the ring edge; 0 enemies alive; the enemy cap reached.
- Network: input vectors clamped to length 1; NaN, Infinity and huge numbers rejected; unknown message types rejected; 1,000 messages a second from one client rate-limited; malformed JSON; out-of-order inputs; stale input from an alt-tabbed client treated as standing still.
- Lobby: names capped at 16 characters and rendered as text only; `<img src=x onerror=alert(1)>`, emoji, right-to-left text, empty and duplicate names; 8 joins in one second; a 9th join refused.
- Load: 8 headless clients and 120 enemies for 15 minutes within the performance budget.

### 1b: Heroes

**Goal:** all four heroes play differently.

**Files touched:** `shared/heroes.ts`, `shared/rules/abilities.ts`, `server/src/sim/heroes.ts`, client hero visuals, the Tide recolour, the HUD ability slots.

**Includes:** Ember, Bastion, Tide and Gale with basic attack, Q zone (no combos yet), E utility and passive; hero pick in the lobby; duplicates allowed.

**Acceptance criteria:** each hero's kit matches `shared/heroes.ts`; all 1b tests pass.

**Tests that must pass:** cooldowns cannot be bypassed; each Q, E and passive does what its definition says; spamming Q; casting while downed is refused; a cast beyond range is clamped; duplicate heroes side by side.

### 1c: Combos

**Goal:** the hook works and gets people shouting.

**Files touched:** `shared/rules/combos.ts`, `server/src/sim/zones.ts`, `server/src/sim/combos.ts`, combo effects and popup on the client, the combo-ready cue.

**Includes:** the six combos (Steam burst, Magma, Firestorm, Mud, Squall, Dust devil) in three shapes (line for ranged plus ranged, burst for melee plus melee, zone for mixed); the combo-ready glow and name on the Q slot; combo events in the match log.

**Acceptance criteria:** all six pairs fire in the right shape; a game-night playtest happens before 1d starts.

**Tests that must pass:** all six pairs with their shapes; the 1.6-second window; two same-element zones never combo; a player cannot combo with themselves; three zones overlapping in one tick fuse one combo, not two; a combo involving a player who disconnects.

### 1d: Power-ups

**Goal:** crates pull heroes out of formation.

**Files touched:** `shared/rules/pickups.ts`, `server/src/sim/pickups.ts`, intermission flow, client crate visuals and pickup slot.

**Includes:** gun (30 shots), mortar strike (mark, then 3 shells), steroids (restores 40% health), flak vest (heavy damage reduction for 8 seconds); crates spawn at or just past the edge; one permanent passive picked from 3 at each intermission.

**Acceptance criteria:** all four power-ups and the passive pick work; all 1d tests pass; security audit 2 passes.

**Tests that must pass:** ammo counts; mortar timing; the passive applies once; two players grab one crate in the same tick; a dead player touches a crate; a mortar marked outside the map; the intermission times out with no pick made.

### 1e: Full run

**Goal:** a complete, finishable run of about 15 minutes.

**Files touched:** `shared/tuning.ts` (wave table), `server/src/sim/waves.ts`, `server/src/sim/enemies.ts`, client enemy variants and spawn telegraph.

**Includes:** rusher, brute and ranged skeletons; 10 fixed waves; the wave-10 boss; a 2-second spawn telegraph; scaling tuned for 1 to 8 players from bot runs and logs.

**Acceptance criteria:** bot runs at 1, 4 and 8 players complete or fail at sensible waves; all 1e tests pass.

**Tests that must pass:** the 10-wave table and the boss; the boss dying in the same tick as the last hero going down counts as a team win; a wave starting while everyone is spectating.

### 1f: Game-night readiness

**Goal:** the night runs without anyone needing help.

**Files touched:** HUD (team panel, colour rings, name tags), end screen, reconnect handling, spectate mode, settings panel.

**Includes:** colour rings and name tags; the team panel; end-screen stats (waves, combos, revives); reconnect within 30 seconds keeping hero and passives; spectate with one support flare per wave; aim assist tuning; the low-quality toggle; a target of 30 seconds from QR scan to the lobby.

**Acceptance criteria:** a first-time player gets from QR scan to the lobby in 30 seconds or less; all 1f tests pass.

**Tests that must pass:** reconnect within 30 seconds keeps the hero and passives; reconnect at 31 seconds does not; a late joiner cannot enter mid-run; the host tab in the background keeps the game running.

### 1g: Art pass

**Goal:** it looks like the look test or better.

**Files touched:** `client/src/render/` (environment, lighting, effects), particle and decal assets.

**Includes:** zone and combo effects for all elements and shapes, the hold point environment (ruins, torches, flag, brazier), lighting and glow, placeholder sound effects.

**Acceptance criteria:** side by side with the look test, nothing looks worse; the performance budget is still met; security audit 3 passes before the first game night outside your home.

**Tests that must pass:** the full regression set; the 15-minute load test; a Playwright smoke test of join, play and end screen.

## Working rules for Claude Code

Every session follows the same loop, and nothing moves forward on a red test.

1. Open the session with the stage name: "Read CLAUDE.md and NOTES.md. We are doing stage 1x."
2. Plan mode first. Claude Code proposes the plan and the list of tests; you approve before any code.
3. Write the stage's tests first and run them to see them fail.
4. Build until every test passes and lint is clean.
5. Stop. Review the stage yourself, play it, and record deviations in NOTES.md.
6. Commit the green stage, then close the session. The next stage starts in a new session.

**Rules that apply in every session**

- One stage per session. A large stage may be split into numbered slices, still one slice per session.
- Never move on with a failing test, a skipped test, or a lint error.
- Ask, don't assume. Every answer goes into NOTES.md with the date.
- New ideas mid-stage go to the parked list, one line each. Adding to Phase 1 means removing something of equal size.
- Any bug found at a playtest becomes a regression test before it is fixed.
- Tuning changes go only through `shared/tuning.ts`.

## Security guardrails and audits

The game runs on a trusted local network, but the server still treats every client as untrusted.

**Guardrails**

- LAN only: the server binds to the local network, and no port is forwarded or exposed to the internet.
- No accounts, passwords, keys or tokens. The only personal data is an in-game name.
- The server is authoritative: it clamps input vectors, validates ability ids and cooldowns, and rate-limits messages per client.
- Names are capped at 16 characters and always rendered as text, never as HTML.
- Host-only commands (start, restart, kick) are checked on the server.
- Match logs stay on the host laptop, contain names only, and can be deleted at any time.
- Git is the only backup needed; nothing else is persisted.

**Audits** (each in a fresh Claude Code session with no build context, given only the repo and this checklist)

| Audit | When | Focus |
| --- | --- | --- |
| 1 | After 1a | Network input, trust boundaries, name handling, rate limits |
| 2 | After 1d | Server authority over pickups, damage and cooldowns |
| 3 | Before the first game night outside your home | LAN exposure, open ports, Docker config, logs |

An audit finding is fixed with a regression test before the next stage starts.

## Performance budget

The reference laptop is JCCJ's Dell Inspiron 15 5518 (Intel i5-11300H, 4 cores and 8 threads, 16 GB RAM, Intel Iris Xe graphics, 1920 x 1080), running Chrome on Ubuntu with WebGL hardware acceleration on.

| Measure | Target |
| --- | --- |
| Low tier, 120 enemies | 60 fps or more |
| Medium tier, 120 enemies | 45 fps or more |
| High tier, 80 enemies | 30 fps or more |
| Host laptop playing on Low while serving 8 clients | 60 fps or more |
| Server tick, 95th percentile | 10 ms or less |
| Memory over a 15-minute run | No steady growth |
| Bandwidth per client | Logged in 1a; a ceiling set after the first measurement |

The check runs from 1a onward with the load test: 8 headless clients and 120 enemies for 15 minutes. The horde is the main cost, so enemies use pooled, lighter animation, and the enemy cap drops on Low if a target is missed.

## Parked

One line each. Nothing here enters Phase 1 unless something of equal size leaves.

- Citadel to defend: consider at the very end.
- Phase 2 heroes: Brand (fire, melee), Quarry (earth, ranged), Undertow (water, melee), Zephyr (air, ranged).
- Hero-specific combo flavours on top of the element-pair system.
- A distinct Tide model from the paid KayKit tier.
- Quaternius art style (tested and not chosen).
- Rocket launcher, bombing run and adrenaline power-ups.
- The element orb power-up.
- Mobile and touch controls.
- Internet play and accounts.
- Meta progression between runs.
- PvP.
- More than 8 players.
- A second map.
- Music and polished audio.
