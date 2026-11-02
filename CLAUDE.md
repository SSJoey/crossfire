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
