# Security audit 1: recheck (2026-11-08)

Cold re-audit of the repo against `audits/audit-1.md` and BRIEF.md "Security guardrails and audits".
Every client is treated as untrusted. No code was changed. The working tree audited is `master` at
`ff7f8bd` plus the uncommitted audit-1 fix changes (`server/src/http/guard.ts`, `tests/regression/`, edits
to `HoldRoom.ts`, `validation.ts`, `tuning.ts`, `types.ts`, `app.ts`, `log/format.ts`).

**How it was checked.** I read the code and the Colyseus 0.18.25 / ws-transport 0.18.4 internals it
relies on. I ran `npm test` (38 files, 334 tests, all pass) and `npm run lint` (clean). Then I started a
production server (`node --import tsx server/src/index.ts`, `PORT=2671`, `BIND_HOST=0.0.0.0`, built client
served) and attacked it from this machine's LAN address `192.168.1.11`. The server sees that address as a
LAN laptop, not loopback. The scripts are in
`/tmp/claude-1000/-home-joey-Documents-Projects-crossfire/48826d45-da58-4a96-be2f-b65b72c1d170/scratchpad/audit-1-recheck/`
(`lib.mjs` speaks raw Colyseus frames; one `probe-*.mjs` per area). The server was stopped afterwards.

## Summary

| #   | Finding                                                                                                                                                                                                                                 | Severity   | Checklist |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------- |
| R1  | A half-joined socket keeps sending unknown-type requests just under the frame cap. The replies queue without bound, so server memory grows about 3 MB/s per seat until it runs out. PING and request frames also skip the token bucket. | **high**   | 4, 17, 19 |
| R2  | One LAN address can take all 8 player seats in about 15 s and lock the lobby. Kicked squatters come straight back.                                                                                                                      | **medium** | 18        |
| R3  | Names that look the same skip the duplicate suffix. Some letters render blank. A lone surrogate shows up differently to players. One grapheme can carry about 1,000 combining marks.                                                    | **low**    | 14        |

Observations that are not findings are listed after the checklist: O1 to O4.

## Checklist

### Network input

**1. Every message type is validated; unknown types are counted and dropped. PASS (with R1).**

- Handlers for `input`, `ready`, `start`, `restart`, `kick`, `addBot`, `removeBots`, `perf` and `*`: `server/src/rooms/HoldRoom.ts:139-217`. Each one calls `guard()` first (`:314-326`). Payloads are validated by `sanitizeInput` (`shared/rules/validation.ts:16-44`), `sanitizePerfReport` (`:62-76`), the boolean check on `ready` (`HoldRoom.ts:150-154`) and the string check on `kick` (`:174-178`).
- Unknown ROOM_DATA types reach the `*` handler, which counts them (`HoldRoom.ts:213-217`). Colyseus keeps handlers in a null-prototype object, so `__proto__` and `constructor` are just unknown types (`node_modules/@colyseus/core/build/utils/nanoevents.mjs`). Live: `__proto__`, `constructor`, `*`, numeric type 9999 and empty frames all left the room running (`probe-frames.mjs`).
- Gap: ROOM_REQUEST frames with an unknown type never reach `*`. Colyseus answers them itself (`RoomMessages.mjs:179-186`), so they are not counted. That gap is part of R1.

**2. Input numbers. PASS.**
`sanitizeInput` requires exactly 7 own keys (`validation.ts:18-21`) and an integer `seq` (`:24`). Numbers must be finite and within ±1e4 (`:7-9, 25-26`), and buttons must be real booleans (`:27`). The move vector is clamped to length 1 (`:29-35`) and the aim point to `mapRadius` (`:36-42`). Live: `NaN`, `Infinity`, `1e5`, `"1"`, `attack: 1`, extra keys and missing keys were all rejected. `{moveX:1000, moveZ:1000, aimX:9999}` was accepted and clamped (`probe-run.mjs`). Unit tests: `tests/unit/shared/validation.test.ts:18-77`.

**3. Sequence numbers. PASS.**
Negative, fractional and > 2^31-1 values are rejected (`validation.ts:5, 24`). Only strictly newer values apply (`acceptSeq`, `:79-81`, used at `server/src/sim/world.ts:189-191`). Repeats and old values do not refresh `lastInputMs`, so they cannot keep a hero alive. A client that sends `2^31-1` freezes only its own hero, and only until the next run: `startRun` recreates every hero with `seq = -1` (`HoldRoom.ts:392-399`, `server/src/sim/heroes.ts:20-22, 42`). `lastSeq` is `uint32` in the schema and is clamped ≥ 0 (`server/src/rooms/state.ts:27`, `HoldRoom.ts:571`). No overflow is possible.

**4. Malformed frames. PASS for crashes; FINDING R1 for unbounded buffering.**
`maxPayload: 16 KB` (`server/src/app.ts:40`): a 17 KB frame was closed with 1009. Invalid or truncated msgpack, a 5,000-deep nested array (stack overflow), protocol bytes `0x00`/`0xff`, text frames, input-protocol frames (19/20), a bare `ROOM_DATA` byte and a truncated str8 type all left the process and room up. Bad msgpack closes that client (4002, `RoomMessages.mjs:121-131`); the rest are ignored (`probe-frames.mjs`). Each bad frame prints a stack trace, but the client is closed and rejoins are limited to 2 per 5 s per address, so the log spam is bounded. The process never crashed during the whole audit.

**5. Stale input. PASS.**
`world.ts:231-237` zeroes move, attack and revive once `isStale` (`validation.ts:84-86`, 250 ms in `shared/tuning.ts:99`). Tests: `tests/unit/server/world.test.ts:31`, `tests/integration/network.test.ts:89`.

**6. Matchmaking options. PASS.**
`onAuth` turns any non-object into `{}` (`HoldRoom.ts:223`). `role` is compared with `===` (`:224`). `botTicket` of any type goes through `typeof === 'string'` (`server/src/bots/tickets.ts:398-399`), and `name` goes through `sanitizeName` (`validation.ts:119-120`). `enemyCap` (load room only) is type-checked and clamped (`shared/rules/loadtest.ts:9-13`). Live, from `probe-options.mjs`:

- Bodies `null`, `[]`, `"str"`, `123`, `{"name":{"toString":1}}`, `{"name":["Bob"]}` and `{"botTicket":["a"]}` were refused with "Please enter a name."
- `{"__proto__":{"role":"host"}}` and `{"role":["host"]}` joined as plain players.
- Malformed JSON got a 400.
- None of them threw, and the room kept accepting joins.

### Trust boundaries

**7. Host commands only from a loopback socket. PASS (see O2).**
`start`, `restart`, `kick`, `addBot` and `removeBots` all require `isHost` (`HoldRoom.ts:160-198, 338-340`). `hosts` is filled only when `onAuth` passed `isHostAddress(context.ip)` (`:224-226, 248-250`). Colyseus resolves `context.ip` from `X-Real-IP`, then `X-Forwarded-For`, then `X-Client-IP`, and only then the socket (`node_modules/@colyseus/core/build/Transport.mjs:48-51`). `GuardedServer.emit` deletes all three headers from every request and upgrade before any listener runs (`server/src/http/guard.ts:41-50, 75-79`). `isLoopbackAddress` is strict (`validation.ts:252-257`). `onAuth` runs at WebSocket connect time with the upgrade socket's address (`Room.mjs:1102-1105`, `WebSocketTransport.mjs:34-40`).

- Live: a LAN client joined with `role:"host"`, headers `X-Forwarded-For`, `X-Real-IP`, `X-Client-IP: 127.0.0.1/::1`, `Forwarded`, `Host: 127.0.0.1` and `Origin: http://127.0.0.1`. It was refused: "The host page only works on the host laptop."
- A LAN player that sent `start`, `restart`, `addBot`, `removeBots` and `kick {sessionId: <host>}`, as plain messages and as requests, changed nothing (`probe-host.mjs`, `probe-trust.mjs`).

**8. LAN clients cannot create rooms, become host, or join unopened rooms. PASS.**
`matchmakeGate` allows only `create` (loopback only) and `joinById` (`validation.ts:202-219`). Every other POST shape gets a 404 or 405 (`guard.ts:53-58`). Live, from LAN:

- `create` was refused for `hold`, `hold_load` and `hold_remote`; `joinOrCreate`, `join`, `reconnect` and `CREATE` were refused too.
- Also refused: `create` with forged XFF, `create/hold/`, absolute-form `POST http://127.0.0.1/matchmake/create/hold`, a chunked `create`, a `create` pipelined behind a valid `joinById` on the same keep-alive connection, and `PUT`.

Players cannot join until a host page has joined (`hostSeen`, `HoldRoom.ts:228, 250`). `hold_remote` is registered only with `testRooms` (`app.ts:34`).

**9. Load room only with `CROSSFIRE_LOAD_ROOM=1`. PASS.**
`server/src/index.ts:8`, `app.ts:35`. The only setter is `tools/load-test.ts:58`, which also binds `127.0.0.1` (`:57`). Docker does not set it (`docker-compose.yml`, `Dockerfile`), and `tests/unit/tools/docker.test.ts:43-45` checks that.

**10. Nobody acts for another player. PASS.**
Inputs carry no id: `setInput(client.sessionId, …)` (`HoldRoom.ts:145`). Ready and perf are keyed by `client.sessionId` (`:156, 202`). Kick is host-only and cannot target a host (`:181`). Session ids are visible to everyone as `players` map keys. That does not help an attacker: opening a socket with someone else's `sessionId` needs a reserved seat or that client's secret reconnection token (`Transport.mjs:128-131`, `Room.mjs:446-452`), and the room never calls `allowReconnection`.

**11. Built-in HTTP routes. PASS.**
The Colyseus router exposes only `POST /matchmake/:method/:room` (`node_modules/@colyseus/core/build/router/default_routes.mjs:6`) and `GET /__healthcheck` (`router/index.mjs:16`). `/` is the game page (`app.ts:50`). Live, `GET /matchmake`, `/matchmake/`, `/colyseus`, `/monitor`, `/playground` and `/api/reference` return 404. No listing exists. `joinById` tells an unknown code ("not found") from a real one, but at 2 attempts per 5 s per address (`guard.ts:68-69`), covering the 331,776 codes takes about 9.6 days. The greeting banner is off (`app.ts:42`).

**12. Static files and `/api/lan`. PASS.**
`express.static(clientDir, {index:false})` (`app.ts:48-52`) ignores dotfiles by default. Live: `/../server/src/index.ts`, `/%2e%2e/%2e%2e/package.json`, `/assets/..%2f..%2fpackage.json`, a raw `GET /assets/../../../NOTES.md` and `/.env` all return 404. `client/dist` holds no symlinks (`find client/dist -type l` is empty). `/api/lan` returns only private IPv4 addresses (`server/src/lan.ts:5-13, 19-31`). Live it returned `192.168.1.11, 172.16.0.2, 172.18.0.1`. The last two are Docker bridge addresses: private, but useless to players (O4).

**13. No server-only state is sent. PASS.**
The synced schema is name, ready and bot per player; position, facing, hp, status, revive and `lastSeq` per hero; position, hp, level, scale and state per enemy; position and direction per bolt (`state.ts:4-72`). The RNG seed, inputs, enemy targets, cooldowns and tickets are not synced. The seed goes only to the host-side log (`HoldRoom.ts:483`).

### Name handling

**14. Name rules. FINDING R3 (low).**
Trim, the 16-grapheme cap, stripping of Cc/Cf/Zl/Zp (bidi overrides included), refusal of empty names, and case-insensitive suffixes all work (`validation.ts:112-144`). Live, `"‮evil"` became `evil`, `x y` became `xy`, and `"   "` and `"‍‍"` were refused. But look-alike duplicates, blank-rendering letters, lone surrogates and combining-mark stacks get through; see R3.

**15. Text only, no HTML. PASS.**
There is no `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `document.write`, `DOMParser` or `createContextualFragment` anywhere in `client/src` or `client/index.html`. `el()` sets `textContent` and creates text nodes (`client/src/dom.ts:17-26`), and `setText` uses `textContent` (`:30-32`). Names are rendered through these helpers:

- the join and lobby screens (`client/src/hud/join.ts:250`)
- the host page (`client/src/hud/host.ts:136`)
- the HUD revive banner (`client/src/hud/hud.ts:107-114`)

Server error text goes through `setText` too (`join.ts:198, 305`, `host.ts:106`). No name reaches an attribute.

**16. Log lines and file names. PASS.**
`logLine` writes `JSON.stringify` plus `\n` (`server/src/log/format.ts:49-51`). U+2028, U+2029 and U+0085 are stripped from names (`validation.ts:112`), and lone surrogates come out escaped (Node's well-formed `JSON.stringify`). Live, the names `"},{"ev":"end` and `x\"<U+2029><U+0085>y` produced 4 lines that all parse. The file name is the ISO time plus a code checked against `^[A-HJ-NP-Z]{4}$` (`format.ts:53-59`). Names never touch a path.

### Rate limits and resource use

**17. Token bucket on every message type, kick after 3 s. PASS for ROOM_DATA; FINDING R1 for other frame types.**
Every ROOM_DATA handler goes through `guard()` (`HoldRoom.ts:314-326`; the bucket is at `validation.ts:150-186`; 60/s, burst 120, kick after 3 s, at `tuning.ts:94-98`). Live, 150 unknown-type ROOM_DATA frames per second were kicked with 4020 after 4.4 s (the burst of 120 lasts about 1.3 s, then the 3 s flood). But PING frames and ROOM_REQUEST frames with an unknown type never reach `guard()`. At 200/s, below the 240/s Colyseus frame cap (`HoldRoom.ts:78`, `tuning.ts:105`), a joined client was **never kicked** in 8 s, for either kind (`probe-frames.mjs`). See R1.

**18. Connection and join floods. FINDING R2 (medium); otherwise PASS.**

- Room size is capped: `maxClients = 8 + 4` (`HoldRoom.ts:73`), host connections need loopback, and `onJoin` caps players at 8 synchronously (`:254-258`).
- A `create` flood from LAN is refused before Colyseus (`guard.ts:61-67`).
- `joinById` is limited to 2 per 5 s per address (`guard.ts:68-69`, `validation.ts:225-249`).
- Live: 4,000 half-written HTTP requests held open from one address cost the server about 5 MB, and the host still got answers. 2,000 WebSockets opened without a room were all closed by Colyseus within 4 s (`WebSocketTransport.mjs:181-185`).
- **But** the limiter caps the join _rate_, not the seats one address _holds_. One address filled all 8 seats in 15.2 s, and the next player was told "The game is full" (R2).

**19. Memory cannot grow without bound. FINDING R1; the room's own maps PASS.**
`net`, `bytesAtPerf`, `leaveReasons`, `reports` and `hosts` are cleaned in `onLeave` (`HoldRoom.ts:267-278`). Enemy and bolt state maps follow the fixed pools (`:574-620`, `world.ts:131-132`). Bot tickets are capped at 8 (`tickets.ts:390-391`). `ReservationLimiter` forgets idle addresses (`validation.ts:238-242`). But Colyseus' per-client `_enqueuedMessages` queue has no bound, and a half-joined client can fill it (R1). A stalled client that keeps sending pongs is noted in O1.

**20. A slow client cannot stall the simulation. PASS (see O1).**
Sends are asynchronous `ws.send`; the tick never waits on a socket. Live, a joined player stopped reading its socket mid-run. The other player kept getting about 20 messages/s for 60 s. Without pongs, the stalled socket was closed by the ws heartbeat within 10 s (server side reached FIN-WAIT-2; `WebSocketTransport.mjs:161-171`). With unsolicited pongs it stayed connected; see O1 (`probe-stall.mjs`).

### Host-added bots and client perf reports

**21. `addBot` / `removeBots`. PASS.**
Both are host-only (`HoldRoom.ts:187-198`). `addBot` is lobby-only and is refused when players plus pending tickets reach 8 (`:345-353`). `removeBots` is lobby-only (`:195`). Human joins count pending tickets as taken (`:256-258`). Bot joins skip that reservation but still hit the 8-player cap in the same synchronous `onJoin` check, so no interleaving of `onAuth` and `onJoin` can push the room past 8. Tests: `tests/integration/hostbots.test.ts`.

**22. Bot tickets. PASS.**
A ticket is `randomUUID()` (122 random bits), works once (deleted on use) and expires after 10 s (`tickets.ts:390-405, 423-425`). Any type is safe (`:399`); live, `{"x":1}` and a well-formed but unknown UUID fell through to a normal named join. A ticket travels only over IPC to the child process and then in a loopback HTTP body, so no LAN client sees one. Being a bot changes only `PlayerState.bot` (shown as "(bot)" on the host page), the log's `bots` list, and the skipped reservation count. It grants nothing a player can use.

**23. Bot child process. PASS.**
It is forked only from `addBot` (host-only), one per room (`this.bots ??=`, `HoldRoom.ts:354`), with fixed entry, `execArgv` and inherited server environment (`server/src/bots/supervisor.ts:49-55`). It is stopped:

- when the last bot leaves (`HoldRoom.ts:283, 374-380`)
- when the last host page leaves (`:274-276`)
- on dispose (`:292-298`)
- by SIGKILL after 2 s if it ignores `stop` (`supervisor.ts:38-46`)

On IPC disconnect it exits by itself (`server/src/bots/process.ts:43`). IPC messages carry only `HoldRoom.botUrl` (set from the server's own listen address, `index.ts:13-16`, `app.ts:30`), the room code, the server-generated name, a counter seed and the ticket (`HoldRoom.ts:358`). One minor robustness note, not a security issue: if a bot's HTTP join fails before its ticket is used, `stopBotsIfIdle` sees the pending ticket and keeps the process. Nothing re-checks after the ticket expires.

**24. Perf reports. PASS.**

- Exact keys, a known tier, finite numbers within the `TUNING.log` limits, and whole-pixel sizes (`validation.ts:62-76`, `tuning.ts:133-136`).
- Accepted only from a player during a run (`HoldRoom.ts:203`), at most one per 5 s (`:207-208`), and only the latest is kept, in a map cleared at run start and on leave (`:210, 475, 273`).
- Live: an extra key, `<img src=x>` as the tier, `1e308`, `800.5` and `"60"` were rejected. A second valid report within 5 s and a report from the host page were rejected. Only `{tier:"low", fps:61.2,…}` reached the log.

### Logs and personal data

**25. Names only, logs on the host. PASS.**
Log events carry names, the room code, the seed, wave and perf numbers; no IP and no session id (`format.ts:11-46`, `HoldRoom.ts:478-530`). The log folder is `./logs` or `LOG_DIR` from the server's own environment (`server/src/log/MatchLog.ts:69-76`). Docker mounts `./logs:/app/logs` (`docker-compose.yml`).

## Findings

### R1 (high): a half-joined socket grows server memory without bound; PING and requests skip the token bucket

**Where.**

- Colyseus attaches the room's message listener as soon as `onJoin` returns, while the client is still `JOINING` (`node_modules/@colyseus/core/build/Room.mjs:1143-1147`).
- An unknown-type ROOM_REQUEST gets an error reply that echoes the type name (`RoomMessages.mjs:179-186`) through `enqueueRaw`.
- While the client is not `JOINED`, that reply is pushed onto `client._enqueuedMessages`, which has no bound (`Transport.mjs:60-76`). The queue is flushed only when the client sends JOIN_ROOM, and a hostile client never does.
- Nothing closes a client that never acknowledges JOIN. The ws heartbeat does not, because the client's ws library answers pings.
- The room's only limits are Colyseus' 240 frames/s cap (`HoldRoom.ts:78`) and our token bucket. The bucket runs only inside ROOM_DATA handlers, so PING and unknown ROOM_REQUEST frames never reach it.

**Reproduction** (`probe-halfjoin.mjs`). From any LAN laptop:

1. `POST /matchmake/joinById/<CODE>` with `{"name":"Ghost"}`, then open `ws://<host>:2567/<processId>/<CODE>?sessionId=<sessionId>`.
2. When the server sends JOIN_ROOM (`0x0a…`), **do not answer** it.
3. Send 200 frames per second of `[0x15, id, 0xda, 0x3a, 0x98, "q" × 15000]`: ROOM_REQUEST, request id, a 15,000-byte msgpack str16 type.

Measured server RSS:

| Time | RSS growth     |
| ---- | -------------- |
| 0 s  | 107 MB (start) |
| 10 s | +36 MB         |
| 20 s | +64 MB         |
| 30 s | +93 MB         |
| 40 s | +123 MB        |

The socket was never closed. Growth is linear at about 3 MB/s, and the memory is not given back after the client leaves.

Joined clients are also never kicked for PING or unknown ROOM_REQUEST at 200/s (checklist 17). Those replies are sent at once, not queued, so that part only wastes bandwidth.

**Impact.** One LAN laptop can exhaust the host laptop's memory. The queued buffers sit outside the V8 heap, so growth continues until the OS OOM killer, and Docker sets no memory limit.

- One seat takes about 10 minutes to reach 2 GB.
- The ghost can hold every seat it gets through R2. 8 seats would give about 24 MB/s. This is extrapolated from the linear single-seat measurement, not measured.
- The ghost looks like a normal player in the lobby. It can even send `ready` while half-joined, so it does not block the start, and it keeps flooding during the run.

Every game in the process dies, and other software on the host laptop may die with it. The existing F4 regression test (`tests/regression/frame-flood.test.ts:91-107`) floods at 1,000/s, so it only shows the cap cuts off a _fast_ flood.

**Proposed fix** (in `HoldRoom`, no Colyseus patch needed):

1. In `onJoin`, add `client.ref.prependListener('message', …)`. It runs `guard()` on **every** raw frame (PING and request frames included) and closes the client (4002) for any frame type the game never sends: ROOM_REQUEST (21), ROOM_DATA_BYTES (17) and the input frames (19, 20). Then the 60/s bucket and the 3 s kick apply to everything.
2. Close any client that has not acknowledged JOIN within `TUNING.lobby.seatReservationSec` (5 s). Set a timer in `onJoin` and clear it when `client.state` becomes JOINED, checked on its next frame. Its seat is then freed.
3. Optional: until a client is JOINED, accept only the JOIN_ROOM ack.

**Regression test** (`tests/regression/half-join.test.ts`):

- (a) A raw client joins without acknowledging and sends 200/s ROOM_REQUEST frames with a 15 KB type. It is closed within 6 s; RSS growth stays under 20 MB; another player keeps getting patches.
- (b) A joined raw client sending 200 PING/s is closed with 4020 within about 4.5 s, and the same holds for unknown ROOM_REQUEST.
- (c) A client that never acknowledges JOIN is gone from `state.players` after about 5 s, and a new player can take its seat.

### R2 (medium): one LAN address can hold every player seat

**Where.** `ReservationLimiter` caps the joins _started_ per address per 5 s window (`validation.ts:225-249`, used at `guard.ts:68-69`). Nothing caps the seats one address _holds_. Each reservation becomes a lasting player as soon as its socket connects (`HoldRoom.ts:239-265`). Kicking is not sticky: a kicked client rejoins at once (`:172-185`).

**Reproduction** (`probe-seatfill.mjs`). From one LAN address, loop: `POST /matchmake/joinById/<CODE> {"name":"Squatter"}`, open the socket, acknowledge JOIN, keep it open. Retry every 0.5 s on 429. Result: seats held reached 2 at 0.0 s, 4 at 5.1 s, 6 at 10.1 s and 8 at 15.2 s. The next real player was refused with "The game is full: 8 players are already in."

**Impact.** One laptop locks the lobby.

- The squatters never send `ready`, and `start` needs every player ready (`HoldRoom.ts:391`), so the host cannot start.
- The host can kick them one by one, but each kicked seat comes back at 2 per 5 s.
- Combined with R1, every squatted seat is also a memory bomb.
- An attacker with several IPv4 aliases on its NIC multiplies the join rate, but the cap below still bounds what each address holds.

**Proposed fix.**

- Remember each player's socket address. `context.ip` in `onAuth` is the socket address once the guard has stripped the forged headers. Refuse a join in `onJoin` when that address already holds `TUNING.lobby.maxPlayersPerAddress` seats (suggest 2) counting players plus reserved seats. Loopback stays exempt for bots and the host's own tabs. Add a new `JOIN_ERRORS` text for it.
- Make kick sticky: a kicked address cannot rejoin for `TUNING.lobby.kickCooldownSec` (suggest 60 s).
- Record both values in NOTES.md.

**Regression test** (`tests/regression/seat-squat.test.ts`): use a test hook so the room sees every join as coming from one LAN address (like `lanClients`).

- (a) The 3rd concurrent seat from that address is refused, even when spaced past the rate window.
- (b) After the host kicks that address, its rejoin within the cooldown is refused, and a join from another address still works.

### R3 (low): look-alike, blank and malformed names get through

**Where.**

- `sanitizeName` keeps ZWJ and ZWNJ (U+200D, U+200C) anywhere, including at the ends (`validation.ts:113, 123`).
- Nothing is normalized (no NFC or NFKC).
- `VISIBLE` counts any `\p{L}`, `\p{N}`, `\p{S}` or `\p{P}` as visible, including letters that render blank (`:114`).
- Lone surrogates (category Cs) are kept.
- The cap counts graphemes, but one grapheme can carry up to about 1,000 combining marks (`:122-124`).
- `uniqueName` compares only with `toLowerCase()` (`:130-144`).

**Reproduction** (`probe-names.mjs`, `probe-names2.mjs`). Join with each of these names. Each one was accepted, as another player's SDK client saw it:

| Name sent                         | What happened                                                                                              |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `Alice` and `Alice‍`              | No suffix; both render as "Alice"                                                                          |
| `Al‌ice`                          | Renders as "Alice"; no suffix                                                                              |
| `Alicе` (Cyrillic е)              | Renders as "Alice"; no suffix                                                                              |
| `José`                            | Kept as decomposed "José"                                                                                  |
| `ㅤ` (Hangul filler, category Lo) | Accepted; renders blank                                                                                    |
| `⠀⠀` (braille blank, So)          | Accepted; renders blank                                                                                    |
| `A\uD800B`                        | Stored on the server as `A\uD800B`; clients decoded `A\u{10042}`. Server and players disagree on the name. |
| `Z` + 900 × U+0301                | Accepted as a 1-grapheme name of 901 UTF-16 units; stacks far outside its line                             |

(`alice` after `Alice` correctly became `alice 2`.)

**Impact.** A player can impersonate another (it matters for kick decisions and the end screen), show up with an invisible name, or break the lobby, host and HUD layout with mark stacks. No code runs and the logs stay valid, so this is low.

**Proposed fix**, in `sanitizeName`:

- Reject the name unless `raw.isWellFormed()` is true.
- Apply `normalize('NFC')`.
- Strip `\p{Default_Ignorable_Code_Point}` except ZWJ/ZWNJ placed between two visible characters. That class covers U+115F, U+1160, U+3164 and U+FFA0.
- Leave U+2800 out of the "visible" test.
- Cap combining marks at 4 per grapheme, or cap the name at 64 UTF-16 units.

In `uniqueName`, compare a _skeleton_ instead of `toLowerCase()`: NFKC, case-folded, with every default-ignorable character removed. Optionally add a small confusables map (Latin, Cyrillic, Greek).

**Regression test** (`tests/regression/name-lookalikes.test.ts`): a table test.

- `uniqueName('Alice‍', ['Alice'])`, `uniqueName('Al‌ice', ['Alice'])` and the NFD form of `José` against the NFC form all get a ` 2` suffix.
- `sanitizeName('ㅤ')`, `sanitizeName('⠀')` and `sanitizeName('A\uD800B')` all return `{ok:false}`.
- `sanitizeName('Z' + '́'.repeat(900)).name.length <= 64`.

## Observations (not findings)

- **O1. A stalled client that keeps sending pongs is never dropped.** A player that stops reading but sends unsolicited pong frames resets the heartbeat (`WebSocketTransport.mjs:10-12`), so the server keeps writing patches into its socket. The backlog grows at the patch rate, about 2 kB/s with 9 enemies here and more with 120, until the run ends. That is slow and bounded by the run, so it is not a finding. Hardening for later: close a client whose `ref.bufferedAmount` exceeds about 1 MB.
- **O2. A web page in the host's own browser can act as host (for audit 3).** Colyseus answers matchmaking preflights with the caller's `Origin` and `Allow-Credentials: true` (`node_modules/@colyseus/core/build/matchmaker/controller.mjs:7-36`), and no WebSocket `Origin` is checked. Any web page open in the host laptop's browser therefore connects from 127.0.0.1 and passes the host check, unless the browser's local-network protections block it. Suggest an allow-list of the server's own origins for WebSocket upgrades and matchmaking.
- **O3. The server binds every interface (for audit 3).** `BIND_HOST=0.0.0.0` (`index.ts:5`, `docker-compose.yml`) also listens on Docker bridges, VPNs and any other interface.
- **O4. `/api/lan` lists Docker bridge addresses** (`172.16.0.2`, `172.18.0.1` here). They are private and harmless, but they are offered to the host as join addresses.

---

## Earlier audit (audits/audit-1-findings.md): fixed or not

_Written after the checklist above was complete._

| Earlier item                                                                           | Status now       | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **F1** Host takeover with a forged IP header (high)                                    | **Fixed**        | `GuardedServer.emit` deletes `x-real-ip`, `x-forwarded-for` and `x-client-ip` on every `request` and `upgrade` before Colyseus resolves the address (`server/src/http/guard.ts:41-50, 75-79`). Colyseus reads exactly these three (`Transport.mjs:48-51`). Live: a LAN client with `role:"host"` and all three headers set to 127.0.0.1/::1 (plus `Forwarded`, `Host`, `Origin`) was refused with "The host page only works on the host laptop" (`probe-host.mjs`). A LAN player's `start`, `restart`, `kick`, `addBot` and `removeBots` had no effect. `tests/regression/host-spoof.test.ts` passes.                                                                                                        |
| **F2** Remote room creation and unbounded matchmaking body (medium)                    | **Fixed**        | `matchmakeGate` allows only `create` from loopback and `joinById`, and requires a declared body of at most 16 KB (`shared/rules/validation.ts:202-219`, `tuning.ts:107`). Any other POST shape is refused (`guard.ts:53-58`). Live from LAN: `create` was refused for `hold`, `hold_load` and `hold_remote`, and `joinOrCreate`, `join` and `reconnect` were refused too. That closes the earlier note in item 11 about codeless `join`. A 17 KB body and a declared 64 MB body got 413; chunked and length-less requests got 411 (`probe-body.mjs`). Pipelined, absolute-form and `PUT` variants were refused as well (`probe-trust.mjs`). Tests `matchmake-gate.test.ts` and `matchmake-lan.test.ts` pass. |
| **F3** PING, input and unknown-request frames skip the token bucket (medium)           | **Partly fixed** | `maxMessagesPerSecond = 240` (`HoldRoom.ts:78`) now cuts off any client above 240 frames/s, so the earlier 3,600/s reproduction is closed. `frame-flood.test.ts` passes. But these frames still never reach the token bucket. Live, a joined client sending 200 PING/s, or 200 unknown ROOM_REQUEST/s, was not kicked in 8 s (`probe-frames.mjs`), so checklist 17 ("every message type… kicked after 3 s") still does not hold below the cap. For a JOINED client the impact is now small: replies go out at once and the rate is capped. Tracked as part of **R1**.                                                                                                                                        |
| **F4** Half-joined socket buffers replies without bound (medium)                       | **Not fixed**    | The fix table says the frame cap "closes the half-joined socket within about 1 s". That is true only for floods above 240/s. At 200/s (`probe-halfjoin.mjs`), with 15 KB unknown-type requests and JOIN never acknowledged, the socket stayed open and server RSS grew about 3 MB/s (+123 MB in 40 s), linear and unbounded. The cause is unchanged: `_enqueuedMessages` has no bound (`Transport.mjs:72-73`), and no timeout closes a client that never acknowledges JOIN. `frame-flood.test.ts:91-107` tests only 1,000/s, so it cannot catch this. Now **R1**, rated high because R2 lets one address hold up to 8 such seats.                                                                            |
| **F5** U+2028 / U+2029 in names reach the log raw (low)                                | **Fixed**        | `STRIP = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu` (`validation.ts:112`); U+0085 is Cc. Live: the name `x y` arrived as `xy` (`probe-names2.mjs`), and a run with the name `x\"<U+2029><U+0085>y` logged `x\\\"y`, every line valid JSON (`probe-run.mjs`). `name-separators.test.ts` passes.                                                                                                                                                                                                                                                                                                                                                                                                                          |
| **Checklist 18 note** One LAN client can reserve all 8 seats and lock real players out | **Partly fixed** | `ReservationLimiter` allows 2 joins per LAN address per 5 s, and the reservation window is now 5 s (`validation.ts:225-249`, `guard.ts:68-69`, `HoldRoom.ts:79`, `tuning.ts:118-120`). An address can no longer hold 8 _unconnected_ reservations; live, the 3rd `joinById` inside the window got 429. But the limiter caps the join rate, not the seats held. An address that connects each reserved seat holds 8 real player seats after 15.2 s, and the next player gets "The game is full" (`probe-seatfill.mjs`). Kicks are not sticky. Now **R2**.                                                                                                                                                     |

**Tests and lint on the audited tree.** `npm test` passes 38 files and 334 tests, `tests/regression/` included. `npm run lint` is clean. All regression tests pass but miss R1 and R2: they flood only above the frame cap, and they test the join rate rather than the seats held.

---

## Fixed (2026-11-08, round 2)

| #   | Fix                                                                                                                                                                                                              | Regression test                            |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| R1  | `HoldRoom.gateFrame`: every frame passes our own frame cap, a frame-type allowlist (closes on anything our clients never send) and the token bucket. A client that doesn't acknowledge JOIN within 5 s is closed | `tests/regression/half-join.test.ts`       |
| R2  | One player seat per LAN address; a kicked address waits 60 s; the host laptop is exempt                                                                                                                          | `tests/regression/seat-squat.test.ts`      |
| R3  | Names: well-formed, NFC, invisible characters stripped (joiners only inside), at most 4 marks per character and 64 units; duplicate check by skeleton with a Cyrillic/Greek look-alike map                       | `tests/regression/name-lookalikes.test.ts` |
| O1  | A client with over 1 MB unsent is dropped                                                                                                                                                                        | `tests/regression/slow-reader.test.ts`     |

O2–O4 are parked for audit 3. Probe re-runs are in NOTES.md (2026-11-08, round 2).
