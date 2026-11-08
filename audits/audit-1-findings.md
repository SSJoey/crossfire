# Security audit 1 — findings

**Scope:** after stage 1a (incl. slice 1a.4). Focus: network input, trust boundaries, name handling, rate limits.
**Method:** cold read of the code + live attack scripts run against the real server (`server/src/index.ts`, `NODE_ENV=production`) bound to `0.0.0.0` on a throwaway port, driven from the host's own LAN IP (`192.168.1.6`) as a "different laptop". Scratch scripts: `/tmp/claude-1000/-home-joey-Documents-Projects-crossfire/48826d45-da58-4a96-be2f-b65b72c1d170/scratchpad/audit-1/`. Nothing in the repo was changed. All servers/bot processes I started have exited; port 2567 was never used.
**Versions in play:** `@colyseus/core` 0.18.25, `@colyseus/ws-transport` 0.18.4, `ws` 8.22.1, `msgpackr` (root).

## Summary

| # | Finding | Severity |
|---|---------|----------|
| F1 | Any LAN client becomes "host" by spoofing an `X-Real-IP` / `X-Forwarded-For` / `X-Client-IP` header: full start/restart/kick/addBot/removeBots control | **HIGH** |
| F2 | Unauthenticated room creation + no HTTP body cap → one LAN laptop drives server RSS to multiple GB (OOM) in seconds | **MEDIUM** |
| F3 | The per-client token bucket never sees `PING`, `ROOM_INPUT`, unknown `ROOM_REQUEST`, or empty/invalid-code frames; a client floods them at ~3,600/s forever without being kicked, and PING floods are reflected as PONGs | **MEDIUM** |
| F4 | A client that reserves a seat and opens the socket but never sends the JOIN ack makes the room buffer every reply (incl. reflected 16 KB request-type names) in memory, unbounded, never kicked | **MEDIUM** |
| F5 | `U+2028` / `U+2029` (line/paragraph separators) survive name sanitising and are written raw into match-log names; a log reader that splits on Unicode line boundaries sees forged extra lines | **LOW** |

Everything else on the checklist passed (details below). The authoritative-sim input validation, name HTML-safety, seat cap, bot ticket/lifecycle, and loopback *logic* are all solid — the host check's only flaw is **which** address it trusts.

---

## F1 — Host takeover by spoofing a client-controlled IP header (HIGH)

**Checklist:** item 7 (fails), and consequently 8, 10, 21.

**Where.** `server/src/rooms/HoldRoom.ts:213-217` (`onAuth`) trusts `context.ip`:

```ts
if (opts.role === 'host') {
  if (!this.isHostAddress(context.ip)) throw new ServerError(403, JOIN_ERRORS.notHost);
  return { role: 'host' };
}
```

`isHostAddress` → `isLoopbackAddress` (`shared/rules/validation.ts:187`) is correct in isolation. The problem is the source of `context.ip`. Colyseus builds it in `createAuthContext` → `resolveClientIp` (`node_modules/@colyseus/core/build/Transport.mjs:48-51`):

```js
function resolveClientIp(headers, remoteAddress) {
  const firstHop = (name) => readHeader(headers, name)?.split(",")[0].trim() || void 0;
  return firstHop("x-real-ip") ?? firstHop("x-forwarded-for") ?? firstHop("x-client-ip") ?? (remoteAddress || void 0);
}
```

These three headers are set by **the client** on the WebSocket upgrade. Crossfire has no reverse proxy in front of it (`docker-compose.yml` uses `network_mode: host`, the server binds `0.0.0.0:2567` directly), so there is nothing trustworthy putting those headers there — any value the attacker sends wins over the real TCP peer address. The brief's own guardrail ("Host = loopback check… Docker must preserve client IPs", NOTES.md:39) is exactly what this subverts: the socket IP is preserved, but it is never consulted.

**Reproduction** (`scratchpad/audit-1/t1_trust.mjs`, run from the LAN IP):

1. Control: a plain WS upgrade asking `{ role: 'host' }` is refused — close 4002, "The host page only works on the host laptop." Correct.
2. Add one header and retry:
   ```
   WS upgrade  GET /<pid>/<roomId>?sessionId=<sid>
   Header:     X-Real-IP: 127.0.0.1         → ACCEPTED as host
   Header:     X-Forwarded-For: 127.0.0.1   → ACCEPTED as host
   Header:     X-Client-IP: 127.0.0.1       → ACCEPTED as host
   ```
3. End-to-end against a genuine host's lobby: a victim joins normally; the attacker reserves a seat on the room code with `POST /matchmake/joinById/<code>` and completes the upgrade carrying `X-Forwarded-For: 127.0.0.1`. The attacker's socket is now a host connection and sending raw msgpack room-data frames did all of:
   - `start` → phase went `lobby → running`
   - `restart` → phase went back to `lobby`
   - `kick {sessionId: <victimId>}` → victim's socket closed with code **4021 (kicked)**
   - `addBot` → a real bot child process joined the attacker-controlled room

   (The victim's session id is freely readable: a plain player sees every `players` entry's session-id key in synced state, so the kick target needs no guessing.)

**Impact.** Complete defeat of the single trust boundary in the game. Any laptop on the Wi-Fi can end everyone's run, kick any player, force-start, and spawn bots in arbitrary rooms — including rooms it opens itself (see F2, each host-spoofed room will also fork a bot process). There are no accounts, so this is the whole access-control model.

**Proposed fix.** Decide "is this the host laptop?" from the real TCP socket, not from `context.ip`. The socket is reachable in `onAuth` the same way `log/perf.ts:60` already reads it — `client.ref._socket` (ws 8.x). Change the instance `onAuth` signature to take the client and check its socket:

```ts
override onAuth(client: Client, options: unknown, _context: AuthContext): AuthResult {
  const socketIp = (client.ref as { _socket?: { remoteAddress?: unknown } })?._socket?.remoteAddress;
  // ...
  if (opts.role === 'host') {
    if (!this.isHostAddress(typeof socketIp === 'string' ? socketIp : undefined))
      throw new ServerError(403, JOIN_ERRORS.notHost);
    return { role: 'host' };
  }
  // ...
}
```

Keep `isHostAddress`/`isLoopbackAddress` as they are. The test double `RemoteOnlyHoldRoom.isHostAddress()` still works. (If reading the private `_socket` is unwanted, the alternative is a `beforeUpgrade` hook on `WebSocketTransport` that deletes `x-real-ip`/`x-forwarded-for`/`x-client-ip` from `req.headers` before Colyseus resolves them — there is no proxy, so they are always forgeable noise.)

**Regression test** (`tests/regression/host-spoof.test.ts`, integration). Current integration tests create the host via `colyseus.sdk.create('hold', { role: 'host' })`, whose socket is loopback, so they can't catch this. Add a test that performs the HTTP seat reservation and raw `ws` upgrade **with** `headers: { 'x-forwarded-for': '127.0.0.1' }` from a non-loopback-looking context and asserts the connection is closed with the `notHost` error / code 4002 and never gains host powers. Because `@colyseus/testing` binds on loopback, the robust form is a unit-style test of the new `onAuth` with a fake `client.ref._socket.remoteAddress = '192.168.1.50'` plus `context.ip = '127.0.0.1'` (header-poisoned) asserting it throws 403 — proving the socket, not the header, decides.

---

## F2 — Unauthenticated room creation + unbounded HTTP body → memory exhaustion (MEDIUM)

**Checklist:** items 8, 18, 19.

**Where.** `server/src/app.ts:28-33` registers `hold` with `defineRoom(HoldRoom)` and no create guard; `onAuth` only gates *players/host*, not room creation itself. A `POST /matchmake/create/hold` with any body creates a fresh room before any socket or auth. There is also no body-size limit on the matchmaking endpoint (`maxPayload: 16*1024` applies only to the WebSocket transport, not to Express/better-call HTTP bodies).

**Reproduction.**
- Create-flood (`scratchpad/audit-1/t3_flood.mjs`): one LAN client, 20 concurrent `POST /matchmake/create/hold`, 20 s → **11,311 rooms created, 0 refused**, server RSS climbed from ~105 MB to **1,338 MB**; `/api/lan` latency rose to ~83 ms. Rooms auto-dispose (RSS fell back after the flood), so it is a spike rather than a permanent leak, but it is trivially sustainable — hold the flood and RSS stays pinned.
- Large bodies (`t6_body.mjs`): 4 concurrent `POST /matchmake/create/hold` each with a 64 MB JSON name are all accepted (200); server RSS reached **2,369 MB** in ~60 s (test self-limited at 6 GB). A 128 MB single body is also accepted. The body is buffered and `merge`d into `clientOptions`, so a handful of parallel large requests can push the 16 GB reference laptop to OOM.
- Combined impact run (`t8_impact.mjs`): during a live 7-player run, the create-flood and big-body stages drove RSS to **1.4 GB then 2.2 GB**. The sim tick itself stayed healthy (p95 ≤ 0.7 ms) — the damage is memory/GC and the matchmaking thread, not tick time — but at OOM the whole process (and everyone's game) dies.

**Impact.** Any LAN laptop can OOM-kill the host server, ending the game for all 8 players, with a few lines of `fetch`. No crash of an individual room, but a crash of the process.

**Proposed fix.** Two independent limits:
1. Cap matchmaking body size. Mount a small JSON size guard on the matchmaking path (e.g. reject `Content-Length` over a few KB before parsing), or put the known-tiny create/join options behind a size check. 16 KB (the WS payload cap) is a reasonable ceiling and matches `sanitizeName`'s own bound.
2. Bound concurrent/owned rooms. The only legitimate room creator is the host page (loopback). Once F1 is fixed so `role:'host'` truly requires loopback, gate `create` on the same loopback check (reject remote `create` outright — a LAN player only ever `joinById`s an existing code, per `client/src/net/connection.ts`). That removes remote room creation entirely. A per-source-IP create rate/concurrency cap is a belt-and-braces addition.

**Regression test** (`tests/regression/create-flood.test.ts`): (a) assert a `create` from a non-loopback socket is refused once the loopback-create gate exists; (b) assert a matchmaking POST whose body exceeds the cap is rejected with 4xx and creates no room.

---

## F3 — Rate limiter is bypassed by protocol frames that never reach `onMessage` (MEDIUM)

**Checklist:** item 17 (partial fail).

**Where.** The token bucket (`shared/rules/validation.ts:148` `RateLimiter`, applied in `HoldRoom.guard`, `HoldRoom.ts:305`) only runs inside the registered `onMessage` handlers and the `'*'` wildcard — i.e. only for `ROOM_DATA` / `ROOM_DATA_BYTES` / `ROOM_REQUEST` frames whose type has a handler or hits `'*'`. Colyseus' own per-second cap is **off**: `room.maxMessagesPerSecond` defaults to `Infinity` (`node_modules/@colyseus/core/build/Room.mjs:80`), and the room never sets it. So frames handled *below* the dispatch layer are unlimited:
- `PING` (0x12) → answered with a PONG every time (`Room.mjs` `_onMessage`), never counted.
- `ROOM_INPUT_RELIABLE`/`UNRELIABLE` (0x13?/0x14 → 19/20) → routed to `_inputController`, which is absent, so silently dropped but never counted/kicked.
- `ROOM_REQUEST` (21) for an **unknown** type → replies with an error frame, handled in `RoomMessages.onRequest` **before** any room handler, never counted.
- Empty frame / unused leading byte (e.g. `0x3f`) → ignored by `_onMessage`, never counted.

**Reproduction** (`scratchpad/audit-1/t5_limits.mjs`, ~3,600 frames/s for up to 6 s per type):

```
ready (known type)        → closed 4020 after ~3.0 s   (limiter works)
unknown type / bytes      → closed 4020 after ~3.0 s   (works, via '*')
request(known: ready)     → closed 4020 after ~3.0 s   (works)
PING (0x12)               → NOT KICKED  (21,760 sent)
unused code 0x3f          → NOT KICKED
ROOM_INPUT (0x13=19)      → NOT KICKED
request unknown type (21) → NOT KICKED
empty frame               → NOT KICKED
```

**Impact.** The guardrail "a client flooding for 3 s is kicked" (checklist 17) is real for game/lobby messages but **not** for raw protocol frames. A client can hold a socket open and burn host CPU/bandwidth indefinitely (PING→PONG reflection is the worst: every ping forces a reply), never tripping the flood kick. It's a nuisance/CPU-DoS vector, not a logic break — the sim tick stayed healthy under a PING flood in `t8_impact.mjs` (p95 ≤ 0.7 ms) — hence MEDIUM, not HIGH.

**Proposed fix.** Set `this.maxMessagesPerSecond` on the room (e.g. to `TUNING.net.burst`) so Colyseus force-closes any client exceeding it at the frame level (`Room.mjs:1405` already does `#_forciblyCloseClient` on breach). That backstops every frame type, including PING, below the dispatch layer, and complements the existing app-level bucket (which stays for the nuanced flood-streak/kick behaviour). Pick a value at or above the legitimate 60/s input rate with headroom.

**Regression test** (`tests/regression/ping-flood.test.ts`): open a raw `ws` to a joined seat, send PING (byte `0x12`) at well above the cap for ~3 s, assert the socket is closed. (A pure unit test can also assert `room.maxMessagesPerSecond` is finite after `onCreate`.)

---

## F4 — Seat-reserved, never-joined socket buffers replies in memory without bound (MEDIUM)

**Checklist:** items 18, 19.

**Where.** Colyseus reserves a seat on `POST /matchmake/...` and holds it for `seatReservationTimeout` (15 s default) until the socket sends the JOIN ack (`Room.mjs` `_onMessage` → `Protocol.JOIN_ROOM` sets state JOINED). Before that ack, `enqueueClientRaw` (`Transport.mjs:72-75`) pushes every outgoing frame into `client._enqueuedMessages` instead of sending — an in-memory array with no cap. An attacker can open the socket, **not** ack, and then provoke replies. `ROOM_REQUEST` with an unknown 16 KB type name is answered with an error frame that echoes the full type name (`RoomMessages.onRequest` `#replyToRequest`), and each reply is enqueued.

**Reproduction** (`scratchpad/audit-1/t5_limits.mjs`, reflection stage): one socket, seat reserved, JOIN never acked, 45,800 request frames each with a 16,000-byte type name, interleaved with PINGs (also enqueued) to keep it progressing. Server RSS grew monotonically **133 → 279 → 420 → 566 → 708 → 852 MB** over 16 s and **stayed at 856 MB** 15 s after the flood stopped (the socket was still open, holding the buffer). It only released when the socket was terminated. The app-level `RateLimiter` never engages because these frames are handled before `guard`, and the client is never kicked (see F3).

**Impact.** A single unprivileged socket grows server memory ~45 MB/s and holds it, with no kick. Combined with F2 this gives an attacker two independent OOM paths. MEDIUM.

**Proposed fix.** Same `maxMessagesPerSecond` backstop as F3 closes the frame-rate side (the client is force-closed before it can enqueue much). Additionally, consider shortening the window where a reserved-but-unjoined socket can be driven, and not registering a reply path for unknown request types to unauthenticated sockets. The cleanest single lever is F3's fix: with a finite per-second frame cap the reflection socket is closed within ~1 s.

**Regression test:** fold into the `ping-flood` regression — assert that a reserved-but-unjoined socket sending request frames far above the cap is force-closed and that server `process.memoryUsage().rss` does not climb past a threshold over the run.

---

## F5 — `U+2028`/`U+2029` survive name cleaning and land raw in log names (LOW)

**Checklist:** items 14 and 16 (partial).

**Where.** `sanitizeName` (`shared/rules/validation.ts:110`) strips `\p{Cc}` (control) and `\p{Cf}` (format, incl. bidi overrides/isolates). It does **not** strip `U+2028` (LINE SEPARATOR) or `U+2029` (PARAGRAPH SEPARATOR), which are category `Zl`/`Zp` and match `\p{Z}`, not `\p{Cc}`/`\p{Cf}`. `VISIBLE` (`\p{L}\p{N}\p{S}\p{P}`) doesn't need them, so a name of `"a b"` passes with the separator intact. `logLine` (`server/src/log/format.ts:48`) uses `JSON.stringify`, which does **not** escape `U+2028`/`U+2029` (they're only a hazard historically in JS source, not JSON). So the raw separator is written into the log line.

**Reproduction** (`scratchpad/audit-1/t11_log.mjs`): joined as name `"a b"`. The `start` log line contains a literal `U+2028`. Each physical line is still one valid JSON object (`JSON.parse` of every `\n`-split line succeeded, 4/4), so the primary guarantee holds — but a consumer that splits on Unicode line boundaries (many editors, `grep`, some log shippers treat `U+2028` as a line break) sees the one `start` line as two, and the attacker controls the text after the break. Not a JSON-injection (the `"},{"ev":"x` name was correctly escaped by `JSON.stringify` — item 16's core claim holds), just a line-boundary spoof for naive readers.

**Impact.** Low: cosmetic/log-integrity against tools that over-split lines; no code execution, no path escape (names never reach a file path — the filename uses only the validated room code, `format.ts:55`), no JSON break for a correct parser.

**Proposed fix.** Add `U+2028`/`U+2029` (and arguably `U+0085` NEL, which also survives today) to the stripped set in `sanitizeName`, e.g. extend `STRIP` to `/[\p{Cc}\p{Cf}  \u0085]/gu`. The existing `KEEP_FORMAT` exception for ZWJ/ZWNJ is unaffected.

**Regression test** (extend `tests/unit/shared/validation.test.ts`): `sanitizeName('a b c')` → `'abc'`; assert the result contains no `\p{Z}` separators other than space.

---

## Checklist results

### Network input
1. **PASS** — unknown types counted + dropped via `'*'` (`HoldRoom.ts:204`); verified garbage never crashes the room (`t4_frames.mjs`, `network.test.ts`).
2. **PASS** — `sanitizeInput` (`validation.ts:16`) rejects NaN/±Inf/`|x|>1e4`/strings/arrays/missing keys; move vector clamped to len 1, aim clamped to `mapRadius`. Confirmed live: `(3,4)`→length 1, 24 bad inputs all rejected, hero coords stay finite.
3. **PASS** — `seq` must be integer in `[0, 2^31-1]`; `acceptSeq` enforces strictly-increasing (`world.ts setInput`). A uint64 `seq` (`0xffff…`) is rejected; out-of-order 5→3→4 keeps 5 (verified).
4. **PASS** — invalid msgpack / truncated / wrong-code / oversized frames never crashed the process across `t4_frames.mjs` (42 crafted frames + 3,000 random frames) and raw-WS malformations (RSV bits, bad opcode, unmasked, 2^63 length, bad UTF-8/close). Frames >16 KB are closed by `ws` with 1009; the room/process stayed alive and served other clients throughout.
5. **PASS** — `isStale` (250 ms) zeroes move/attack/revive (`world.ts stepHeroes`); confirmed by existing test and under stalled TCP clients.
6. **PASS** — `onAuth`/`onJoin` tolerate any `options` shape: non-object coerced to `{}`, bad `botTicket`/`name`/`role` never throw (verified `null`/array/number/`{toString}` bodies and tickets all handled). Prototype-pollution attempts (`__proto__`, `constructor.prototype`) via create/join body had no effect (Colyseus `merge` skips `__proto__`, `Utils.mjs:80`).

### Trust boundaries
7. **FINDING F1** (logic correct, source of IP wrong).
8. **FINDING** — covered by F1 (host) + F2 (remote room creation). `hold_load`/`hold_remote` are correctly *not* registered in production (`create hold_load`→520 "not defined", verified). A LAN client cannot join a room whose code it doesn't know (no listing — see 11), but it *can* create its own rooms (F2).
9. **PASS** — `hold_load` only with `CROSSFIRE_LOAD_ROOM=1` (`index.ts:8`, `app.ts:32`); nothing in `docker-compose.yml`/`Dockerfile` sets it (asserted by `tests/unit/tools/docker.test.ts`); only `tools/load-test.ts:58` sets it.
10. **PASS** (within the role model) — inputs are keyed by the sender's own `client.sessionId` server-side (`HoldRoom.ts:136`), never a client-supplied id; `kick` is host-only. The one cross-player action (kick) is gated by the host check, so its weakness is entirely F1.
11. **PASS** — no room-listing/monitor/playground routes exposed. Probed `/matchmake`, `/matchmake/hold`, `/rooms`, `/monitor`, `/playground`, `/api/reference`, `/__stats` → all 404 (served the SPA index). `/__healthcheck`→200 "OK" (no data). `POST /matchmake/join/hold` and `/matchmake/joinOrCreate/hold` *do* let a codeless client land in an existing public room — acceptable for join-by-matchmaking but note it means "knowing a code" isn't strictly required to reach the single active room; worth locking join to `joinById` only once F2's create-gate lands.
12. **PASS** — static serving via `express.static(clientDir)` with `/` and `/host` → `index.html`; `/.env`, `/package.json`, `/api/rooms` → 404. `express.static` already normalises `..`/encoded dots. `/api/lan` returns only private IPv4 (`lan.ts privateRank`), verified `["192.168.1.6","172.16.0.2","172.18.0.1"]` — no public IPs, no hostnames. (Symlink traversal not exercised; `express.static` default `dotfiles:'ignore'` + path normalisation is standard-safe.)
13. **PASS** — synced state (`rooms/state.ts`) carries only gameplay fields. The RNG seed is server-only (`World.rng`), *except* the match **log** records `seed` — but the log stays on the host, not sent to clients. No other-player inputs are broadcast. (Session ids are visible in the `players` map keys, which is how kick targeting works; that's inherent to Colyseus schema maps, low concern on LAN.)

### Name handling
14. **PASS with F5 caveat** — trimmed, capped at 16 graphemes (emoji x20→16 graphemes/32 UTF-16; family emoji→5 graphemes), control+bidi stripped (bidi `a‮…`→`abcde`), empty/whitespace/combining-only/PUA/unassigned/non-string all refused, zalgo bounded by the `maxLength*64` pre-slice (1000 combining marks → 1 grapheme, fast). **Gap:** `U+2028`/`U+2029`/`U+0085` survive (F5).
15. **PASS** — all DOM text goes through `textContent` (`client/src/dom.ts:20,31`); no `innerHTML`/`insertAdjacentHTML`/`outerHTML`/`document.write`/`.html()`/`srcdoc`/template-string HTML anywhere in `client/src` or `client/index.html` (grep clean). Names in join screen, lobby, host page, HUD (`game.ts:349 canRevive`), end screen all use `el({text})`/`setText`.
16. **PASS with F5 caveat** — `logLine` = `JSON.stringify` + `\n`; a name like `"},{"ev":"x` is correctly escaped and stays one JSON object (verified every log line parses). Names never enter a file path (filename = ISO time + validated room code, `format.ts:55-57`; invalid codes throw). The only wrinkle is F5's `U+2028` line-splitting for naive readers.

### Rate limits and resource use
17. **FINDING F3** — bucket works for game/lobby/unknown-type messages (flooder kicked with 4020 in ~3 s, verified, others unaffected) but misses raw protocol frames.
18. **FINDING** — connection/join flood: the 8-player cap holds (9th player refused "game is full", `playerCount` never exceeds 8; verified), and seat reservations are re-checked synchronously in `onJoin` so simultaneous joins can't overshoot. **But** F2 (room creation) and F4 (reserved-unjoined buffering) are unbounded memory. Also noted: one LAN client can reserve all 8 seats via repeated `POST joinById` and lock out real players for the 15 s reservation window (verified: 9 reservations → room locked → genuine player refused 522 until seats lapsed ~14 s later; sustained re-reservation kept a human mostly locked out). Low-impact griefing, folds into the F2 create/rate-limit fix.
19. **PASS (room maps) / FINDING (Colyseus buffers)** — room-owned maps are cleaned on leave: `net`, `bytesAtPerf`, `reports`, `leaveReasons`, `players`, hero/enemy/bolt states all `delete`d in `onLeave`/`backToLobby` (verified playerCount→0 and bot procs→0 after leaves; pools are fixed-size). The unbounded growth is Colyseus-side (F4), not the room's own maps.
20. **PASS** — stalled/slow clients don't stall the sim. With 3 TCP clients that complete the handshake then stop reading (one never ponging, two ponging), a 90 s run kept tick p95 ≤ 0.55 ms, patch p95 ≤ 0.7 ms, steady ~106 MB RSS, and the run progressed normally for the good players (`t7_slow.mjs`). ws ping/retry terminates dead sockets; buffered writes to a slow socket are per-client and don't block the tick loop.

### Host-added bots and client perf reports (1a.4)
21. **FINDING** — `addBot`/`removeBots` are host-only and lobby-only in code (`HoldRoom.ts:178-189`) and that logic is correct, but the host check is F1-defeatable, so a spoofed host adds/removes bots freely (verified). Cap integrity itself is sound: bots count against 8, pending tickets reserve seats (`onJoin` `reserved`), and a burst of 30 `addBot` + 6 racing humans settled at exactly 8 players with no overshoot (verified). In-run `addBot`/`removeBots` are ignored (verified).
22. **PASS** — bot tickets are `crypto.randomUUID()`, one-shot, 10 s TTL (`tickets.ts`). A LAN client sending `botTicket` of every type (`1`, `null`, `{}`, `[]`, `true`, `''`, 5 KB string, `{toString}`, a bogus UUID) just joins as a normal, non-bot player — never marked `bot`, never throws (verified: all "joined as normal", player list shows no bot). Expired/blocked tickets free their seat (verified: a ticket blocked by a locked lobby lapsed after ~10 s and a later `addBot` succeeded). Being a bot confers no extra powers (bots only send `ready`/`input`).
23. **PASS** — one bot process per room (`BotSupervisor`), started on first `addBot`, stopped when the last bot leaves (verified procs→0 after removeBots/kick-last-bot/bot-leave), when the last host page leaves (verified procs→0 after host left mid-run), and it never outlives the server: on `SIGKILL` of the server the bot process exited in **77 ms**, on `SIGTERM` in **78 ms** (via `process.on('disconnect')`, `bots/process.ts:41`). Fork args/env/IPC carry only server-owned values (room code, generated `Bot N` name, ticket, server's own loopback `botUrl` from `index.ts:12-14`); nothing client-supplied reaches them.
24. **PASS** — `sanitizePerfReport` (`validation.ts:62`) enforces exact keys, known tier, finite ranges (`TUNING.log`); accepted only from a player during `running` with ≤1 per 5 s, latest-only kept, cleared on leave (`HoldRoom.ts:191-202,466,264`). Verified: bad reports (fps 1e9, tier "ultra", non-integer w, extra key, string fps, `__proto__` key) all rejected; a second report inside the 5 s gap did not replace the first; report values that could break a log line are impossible (all numeric/enum). Bots send none.

### Logs and personal data
25. **PASS** — logs contain names + gameplay only; a full run's log had **no** IP/session id (`/192\.168|127\.0\.0\.1|sessionId/` → no match, verified). `kBps`/`clients` perf maps are keyed by player **name**, not id (`writePerf`). Logs are written to `./logs` on the host (`MatchLog`/`logDir`, Docker-mounted `./logs:/app/logs`). F5 is the only blemish (separator chars inside a name), not a leak of extra personal data.

---

## Fix-priority order for stage 1b

1. **F1** (host IP source) — one-line trust fix, highest impact; unblocks the correct fixes for F2/8/21.
2. **F3 + F4** — set `room.maxMessagesPerSecond` (finite); closes both the frame-flood bypass and the reflection-buffer OOM in one change.
3. **F2** — gate `create` on loopback (after F1) + cap matchmaking body size; removes remote room creation and the big-body OOM, and incidentally the 8-seat reservation griefing (18).
4. **F5** — strip `U+2028`/`U+2029`/`U+0085` in `sanitizeName`.

Each pairs with the regression test named in its section, to be added under `tests/regression/` before 1b begins.
