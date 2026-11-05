# Security audit 1 (after stage 1a)

**When:** after stage 1a, before stage 1b starts.
**Focus (BRIEF.md):** network input, trust boundaries, name handling, rate limits.
**How:** a fresh Claude Code session with no build context, given only the repo and this checklist.
Every finding is fixed with a regression test (in `tests/regression/`) before stage 1b starts.

## Prompt to paste into the fresh session

```text
You are doing security audit 1 of this repo. You have no build context on purpose.
Read audits/audit-1.md (this checklist) and the "Security guardrails and audits" section of BRIEF.md.
Treat every client as untrusted. Audit the code; do not change it.
For each checklist item, write PASS, FINDING or NOT APPLICABLE with evidence (file:line).
For each finding give: severity (high / medium / low), a concrete reproduction (a script or the
exact messages a malicious LAN client sends), the impact, and a proposed fix with the regression
test that would prove it. You may write and run throwaway scripts in a scratch folder to confirm a finding.
Write the report to audits/audit-1-findings.md and stop. Do not fix anything.
```

## Threat model

- The game runs on a home or game-night Wi-Fi. Every other laptop on that network is a possible attacker: it can open WebSockets, send any bytes, and call any HTTP endpoint on port 2567.
- The host laptop is trusted. Only it may start, restart and kick (a connection from 127.0.0.1 / ::1).
- Nothing is reachable from the internet (no port forwarding). Audit 3 covers LAN exposure and Docker in depth; note anything you see here anyway.
- Personal data is an in-game name only.

## Where to look

- `server/src/rooms/HoldRoom.ts`: message handlers, auth, host check, rate limit, kick, add/remove bots, client perf reports, the load-test room.
- `server/src/bots/`: bot tickets (`tickets.ts`), the bot child process (`process.ts`, `supervisor.ts`, `ipc.ts`), the bot client and brain.
- `server/src/app.ts`, `server/src/index.ts`: rooms registered, HTTP routes, static files, WebSocket max payload, bind address, `CROSSFIRE_LOAD_ROOM`.
- `shared/rules/validation.ts`: input sanitising, perf report sanitising, names, rate limiter, loopback check, sequence numbers.
- `shared/tuning.ts` (`net`, `lobby`): limits.
- `server/src/log/`: match log content and file names.
- `client/src/hud/`, `client/src/dom.ts`: how names and server text are rendered.
- `docker-compose.yml`, `Dockerfile`: host networking, user, mounts.
- Existing tests: `tests/integration/network.test.ts`, `tests/integration/lobby.test.ts`, `tests/integration/hostbots.test.ts`, `tests/integration/matchlog.test.ts`, `tests/unit/shared/validation.test.ts`.

## Checklist

### Network input

1. Every client → server message type has a handler that validates its payload; anything else is counted and dropped without crashing the room.
2. Input numbers: NaN, ±Infinity, |x| > 1e4, strings, nested objects, arrays and missing fields are rejected. The move vector is clamped to length 1 and the aim point to the map.
3. Sequence numbers: old, repeated, negative, fractional or huge `seq` values cannot freeze a hero, skip inputs or overflow.
4. Malformed frames (invalid msgpack, truncated frames, wrong protocol bytes, oversized frames over 16 KB) never crash the process or the room.
5. Stale input (no message for 250 ms) leaves the hero standing still with buttons released.
6. Matchmaking options sent on create/join (`role`, `name`, `enemyCap`, anything else) are validated; unexpected types cannot throw inside `onAuth`/`onJoin`.

### Trust boundaries

7. Start, restart and kick are refused for anyone but a loopback host connection. The check uses the socket address, not a header (`X-Forwarded-For`, `Host`, `Origin`) a client controls.
8. A LAN client cannot create rooms (including `hold_load`, and `hold_remote` outside tests), cannot become host, and cannot join a room the host page has not opened.
9. The load-test room exists only with `CROSSFIRE_LOAD_ROOM=1`; nothing in production (scripts, Docker) sets it.
10. A player cannot act for another player (session ids, kick payloads, inputs carrying someone else's id).
11. Colyseus' built-in HTTP routes (matchmaking, room listing, any monitor or playground) expose nothing beyond what joining needs. Room codes can't be listed by a LAN client.
12. Static file serving cannot read files outside `client/dist` (path traversal, encoded dots, symlinks). `/api/lan` reveals only private LAN addresses.
13. Server-only state (other players' inputs, RNG seed, anything a cheater could use) is not sent to clients beyond what the game shows.

### Name handling

14. Names are trimmed, capped at 16 grapheme clusters, stripped of control and bidi override characters; empty names are refused; duplicates get a suffix.
15. Names are rendered with `textContent` only, everywhere (join screen, lobby, host page, HUD, end screen). Search for `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `document.write` and template-string HTML.
16. Names in the match log stay one valid JSON line each; names never become part of a file path.

### Rate limits and resource use

17. The per-client token bucket (60/s, burst 120) applies to every message type, including unknown ones; a client flooding for 3 s is kicked.
18. Connection and join floods: many sockets or join attempts from one LAN machine cannot exhaust memory, lock the lobby, or push the room past 8 players + 4 host connections.
19. Nothing a client sends can grow server memory without bound (maps keyed by session id are cleaned on leave; pools are fixed).
20. A slow or stalled client cannot stall the simulation for everyone.

### Host-added bots and client perf reports (slice 1a.4)

21. `addBot` and `removeBots` are refused for anyone but a loopback host connection, and outside the lobby. Bots count against the 8-player cap; seats promised to bots still on their way are reserved, and no burst of `addBot` pushes the room past 8.
22. Bot tickets: a LAN client cannot guess, reuse or replay one to be marked a bot, and nothing a client sends in `botTicket` (any type) can throw. Expired tickets free their seat. Being a bot gives no extra power anyway: check that is true.
23. The bot child process: started only by the room, one per room, stopped when its last bot leaves, when the last host page leaves and when the room is disposed; it never outlives the server (IPC disconnect). Nothing a client sends reaches the fork arguments, environment or IPC messages except through the room's own values (room code, generated name, ticket); the bot URL comes from the server's own listen address.
24. Client `perf` reports: exact keys, a known tier, finite numbers within limits (`TUNING.log`), accepted only from players during a run, at most one per 5 s per player, and only the latest one per player is kept (memory bounded, cleared on leave). Report values cannot break a log line.

### Logs and personal data

25. Match logs hold names only: no IP addresses, session ids or other personal data. Logs stay on the host (`./logs`).

## How to run things

- `npm ci`, then `npm test` (unit + integration), `npm run lint`, `npm run test:e2e` (first time: `npx playwright install chromium`).
- `npm run server` starts the game server on port 2567; `npm run build` first to serve the client.
- `tools/smoke-server.ts` and `tools/bots/` show how a scripted client connects with `@colyseus/sdk`.
