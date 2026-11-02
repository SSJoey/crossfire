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
