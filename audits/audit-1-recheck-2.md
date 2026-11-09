# Security audit 1: recheck 2 (2026-11-08)

This is the third pass of audit 1: a cold re-audit of the repo against `audits/audit-1.md` and the "Security
guardrails and audits" section of BRIEF.md. Every client is treated as untrusted, and no project source or
test file was changed. The tree audited is `master` at `c8daae6` plus the uncommitted round-2 fixes
(`HoldRoom.ts`, `validation.ts`, `tuning.ts`, `types.ts`, `app.ts`, `client/src/net/joinflow.ts`, both
`tsconfig.json` files, and four new tests in `tests/regression/`).

**How it was checked.**

- I did my own full pass of the checklist before reading any earlier report. I read the code and the
  Colyseus internals it relies on. Versions checked in `node_modules`: `@colyseus/core` 0.18.25,
  `@colyseus/ws-transport` 0.18.4, `@colyseus/sdk` 0.18.9, `@colyseus/schema` 5.0.43, `ws` 8.22.1,
  `msgpackr` 2.1.4, `express` 5.3.0, on Node 22.21.0.
- `npm test`, `npm run lint` and `npm run typecheck` (results at the end).
- Live: I ran a production server (`NODE_ENV=production PORT=2672 BIND_HOST=0.0.0.0 node --import tsx
server/src/index.ts`, built client served, logs to the scratch folder) and attacked it from two
  non-loopback addresses of this machine: `192.168.1.11` (Wi-Fi) and `172.16.0.2` (WARP). The server sees
  them as two different LAN laptops. Connections to the Docker bridge addresses arrive from `192.168.1.11`,
  so they don't count as a third laptop.
- The scripts are in
  `/tmp/claude-1000/-home-joey-Documents-Projects-crossfire/48826d45-da58-4a96-be2f-b65b72c1d170/scratchpad/audit-1-recheck-2/`.
  `lib.mjs` speaks raw Colyseus frames, and there is one `t*.mjs` per area.
- Floods and abuse were tested both above and just under every limit: the 240 frames/s cap, the 60/s
  bucket, the 16 KB body and frame limits, the 5 s ack window and the 2-per-5-s join limit.
- The server was stopped afterwards. Port 2567 was never touched.

## Summary

| #   | Finding                                                                                                                                                                                                               | Severity | Checklist |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| N1  | The look-alike check folds only Cyrillic and Greek. `AIice` (capital I) sits next to `Alice` with no suffix, and the UI fonts draw I and l the same. Armenian, Cherokee, small-capital and `ɑ` look-alikes also pass. | **low**  | 14        |

There are no high or medium findings. Every earlier finding (F1 to F5, R1 to R3, O1) is fixed; R3 leaves the
residual gap above. The observations after the checklist (P1 to P9) are not findings.

## Checklist

### Network input

**1. Every message type is validated; anything else is counted and dropped. PASS.**

- Handlers exist for `input`, `ready`, `start`, `restart`, `kick`, `addBot`, `removeBots`, `perf` and `*`
  (`server/src/rooms/HoldRoom.ts:206-283`).
- Payload checks:
  - `sanitizeInput` (`shared/rules/validation.ts:16-44`);
  - `sanitizePerfReport` (`:62-76`);
  - the boolean check on `ready` (`HoldRoom.ts:215-219`);
  - the string check on `kick` (`:239-243`).
- Unknown ROOM_DATA types reach `*`, which counts them (`:280-283`). Colyseus keeps handlers in a
  null-prototype object, so `__proto__` and `constructor` are just unknown types
  (`node_modules/@colyseus/core/build/utils/nanoevents.mjs`).
- Every other frame type is now refused before Colyseus sees it: `gateFrame` (`HoldRoom.ts:418-433`), with
  the allowlists at `:60-61`.
- Live (`t3-flood.mjs`): an unknown type, a numeric type (`[13,5,0x80]`), a bare `[13]` and a truncated
  str8 `[13,0xd9]` were accepted as unknown messages and the client stayed connected. PING, ROOM_REQUEST,
  ROOM_DATA_BYTES, input frames (19), a second JOIN ack, an empty frame and a text frame each closed the
  client with 4002.

**2. Input numbers. PASS.**
`sanitizeInput` checks:

- exactly 7 own keys (`validation.ts:18-21`);
- an integer `seq` in 0..2^31-1 (`:24`);
- finite numbers within ±1e4 (`:7-9, 25-26`);
- real booleans for the buttons (`:27`).

The move vector is clamped to length 1 (`:29-35`) and the aim point to `mapRadius` (`:36-42`). msgpackr
2.1.4 renames a `__proto__` map key to `__proto_`, so a payload cannot change its own prototype (checked
offline). Unit tests: `tests/unit/shared/validation.test.ts`.

**3. Sequence numbers. PASS.**
Negative, fractional and out-of-range values are rejected (`validation.ts:5, 24`). Only strictly newer values
apply (`acceptSeq`, `:79-81`, used at `server/src/sim/world.ts:117-130`), and old or repeated values don't
refresh `lastInputMs`. Sending `2^31-1` freezes only the sender's own hero, and only until the next run
(`server/src/sim/heroes.ts:64-68`). `lastSeq` is `uint32`, clamped ≥ 0 (`HoldRoom.ts:706`).

**4. Malformed frames. PASS.**

- `maxPayload` is 16 KB (`server/src/app.ts:41`). Live, a 16 KB + 3 byte frame was closed with 1009, and
  `perMessageDeflate` is off by default (`WebSocketTransport.mjs:47-52`).
- Invalid msgpack (`0xc1`) and a 15,000-deep nested array (stack overflow) are caught inside
  `RoomMessages.onData` (`RoomMessages.mjs:120-131`) and close that client with 4002.
- The process, the room and a second player stayed up through every case (`t3-flood.mjs`; `/__healthcheck`
  answered 200 after each).

**5. Stale input. PASS.**
`world.ts:160-165` zeroes move, attack and revive once `isStale` (`validation.ts:84-86`; 250 ms,
`shared/tuning.ts:99`).

**6. Matchmaking options. PASS.**
`onAuth` turns any non-object into `{}` (`HoldRoom.ts:292`), and `role` is compared with `===` (`:293`).
`botTicket` of any type goes through `typeof === 'string'` (`server/src/bots/tickets.ts:33`), and `name`
goes through `sanitizeName`. Live (`t10-opts.mjs`):

- the bodies `null`, `[]`, `123`, `"str"`, `{"name":{"a":1}}` and an unknown UUID ticket were refused with
  "Please enter a name.";
- `{"__proto__":{"role":"host"}}`, `{"role":["host"]}`, `{"botTicket":{"length":1}}` and extra keys
  (`enemyCap: 1e308`, `reconnectionToken`) joined as plain players;
- the server stayed up.

### Trust boundaries

**7. Start, restart and kick only from a loopback socket. PASS.**

- All host commands require `isHost` (`HoldRoom.ts:225-266, 473-475`). `hosts` is filled only after `onAuth`
  passed `isHostAddress(context.ip)` (`:293-296, 312-316`).
- Colyseus prefers `x-real-ip`, then `x-forwarded-for`, then `x-client-ip` over the socket address
  (`node_modules/@colyseus/core/build/Transport.mjs:48-51`). `GuardedServer.emit` deletes all three on every
  `request` and `upgrade` before any listener runs (`server/src/http/guard.ts:41-50, 75-79`).
  `isLoopbackAddress` is strict (`validation.ts:401-406`).
- Live (`t1-trust.mjs`): a LAN client asked for `role:"host"` with forged `X-Forwarded-For`, `X-Real-IP`,
  `X-Client-IP`, `Forwarded`, `True-Client-IP` and `CF-Connecting-IP`, all set to 127.0.0.1, on both the
  HTTP leg and the WebSocket leg. It got "The host page only works on the host laptop." A LAN player that
  sent `start`, `restart`, `kick`, `addBot` and `removeBots` changed nothing.

**8. A LAN client can't create rooms, become host, or join an unopened room. PASS.**

- `matchmakeGate` allows only `create` (loopback only) and `joinById` (`validation.ts:357-368`). Every other
  POST shape gets 404 or 405 (`guard.ts:53-58`).
- Live from LAN, all refused:
  - `create` for `hold` and `hold_load` (403);
  - `joinOrCreate`, `join`, `reconnect`, `query` (403);
  - `/MATCHMAKE/create/hold`, `/matchmake/create/hold/`, `//joinById`, a raw `/./matchmake/create/hold`
    and `%63reate` (404/403);
  - a lowercase `post` (400);
  - GET with a body (404);
  - a `create` pipelined behind a valid `joinById` on one connection (403, `t5b.mjs`).
- Players need a host page first (`hostSeen`, `HoldRoom.ts:297`). `hold_remote` exists only with
  `testRooms` (`app.ts:35`).

**9. The load room only with `CROSSFIRE_LOAD_ROOM=1`. PASS.**
`server/src/index.ts:8`, `app.ts:36`. The only setter is `tools/load-test.ts:58`. Docker sets neither it nor
`lanClients`/`testRooms` (`docker-compose.yml`, `Dockerfile`).

**10. Nobody acts for another player. PASS.**
Inputs, ready and perf are keyed by `client.sessionId` (`HoldRoom.ts:211, 221, 269`). Kick is host-only and
can't target a host (`:246`). Session ids are visible to everyone as `players` keys, but opening a socket
with one needs that seat's reservation or the client's secret reconnection token
(`Transport.mjs:128-131`, `Room.mjs:1049-1066`). The room never allows reconnection.

**11. Built-in HTTP routes. PASS.**
The Colyseus router has only `POST /matchmake/:method/:roomName` (`router/default_routes.mjs:6`) and
`GET /__healthcheck` (answers `OK`, `router/index.mjs:16`). Live, `/matchmake`, `/matchmake/hold`,
`/colyseus`, `/monitor`, `/playground`, `/rooms` and `/api/rooms` all return 404. There is no room listing,
and the greeting is off (`app.ts:43`).

**12. Static files and `/api/lan`. PASS.**
`express.static(clientDir, { index: false })` (`app.ts:49-53`). Live with `--path-as-is`: `/../package.json`,
`/%2e%2e/package.json`, `/assets/..%2f..%2f..%2fpackage.json`, `/..%5c..%5cpackage.json`,
`/models/../../package.json`, `//etc/passwd`, `/.env` and `/assets/%00` all return 404. `client/dist` holds no
symlinks. `/api/lan` returned `192.168.1.11, 172.18.0.1, 172.16.0.2`, all private (`server/src/lan.ts`; see
O4, still parked).

**13. No server-only state is sent. PASS.**
The schema carries name, ready and bot per player; position, facing, hp, status, revive and `lastSeq` per
hero; and the visible fields of enemies and bolts (`server/src/rooms/state.ts:4-72`). The seed, inputs,
cooldowns and tickets stay on the server. The seed goes only to the host's log.

### Name handling

**14. Trim, 16 graphemes, strip control and bidi characters, refuse empty names, suffix duplicates. PASS,
with FINDING N1 (low).**
`sanitizeName` (`validation.ts:169-189`) works as follows:

- refuses malformed strings (`isWellFormed`);
- applies NFC;
- strips Cc, Cf, Zl, Zp, default-ignorable characters and U+2800 (`:118`);
- keeps ZWJ/ZWNJ only between kept characters, and selectors and tags only after one (`:131-149`);
- caps marks at 4 per grapheme, the length at 16 graphemes and 64 UTF-16 units;
- refuses names with nothing visible.

`uniqueName` compares skeletons (`:241-262`). Offline table (`t7-names.ts`, 50 inputs):

- **Refused:** RLO, Hangul fillers (U+3164, U+FFA0), the Khitan filler, braille blanks, tag-only,
  selector-only and joiner-only names, lone high and low surrogates, combining-only names, ideographic
  spaces, U+FFFF, private-use characters and U+10FFFF.
- **Stripped:** U+2028, NEL, SHY, CGJ, word joiner, Mongolian selector, ALM.
- **Capped:** 5,000 characters became 16; zalgo kept 4 marks.

Live (`t8-names-live.mjs`): `\ud800Bob` was refused, and `Aliсe` (Cyrillic с) became `Aliсe 2`. But
`AIice` joined next to `Alice` with no suffix; see N1.

**15. Text only, never HTML. PASS.**
There is no `innerHTML`, `insertAdjacentHTML`, `outerHTML`, `document.write`, `DOMParser`,
`createContextualFragment` or `srcdoc` in `client/src`. `el()` sets `textContent` and makes text nodes
(`client/src/dom.ts:12-27`), and `setText` uses `textContent` (`:30-32`). Names go through these helpers:

- the lobby (`client/src/hud/join.ts:250`);
- the host page (`client/src/hud/host.ts:136`);
- the HUD.

No name reaches an attribute.

**16. Log lines stay valid; names never reach a path. PASS (see P1).**
`logLine` is `JSON.stringify` plus `\n` (`server/src/log/format.ts:49-51`). The file name is the ISO time
plus a code checked against `^[A-HJ-NP-Z]{4}$` (`:56-59`). Live, every line of every match log parsed. The
log of `t9-log.mjs` (player names `__proto__` and `Normal`) had 6 valid lines. The `__proto__` player's
perf numbers were missing; see P1.

### Rate limits and resource use

**17. The token bucket applies to every message type; a 3 s flood is kicked. PASS.**
Every ROOM_DATA frame goes through `guard()` in the gate (`HoldRoom.ts:431-445`). Every other frame type
closes the client. The bucket is at `validation.ts:299-335` (60/s, burst 120, kick after 3 s). Live
(`t3-flood.mjs`), with a bystander player connected throughout:

| Rate (unknown-type ROOM_DATA)     | Result                                                                                                        |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| 300/s, 260/s                      | 4002 (frame cap) in under 1 s                                                                                 |
| 239/s (just under the cap)        | 4020 (flood) after 3.7 s                                                                                      |
| 120/s                             | 4020 after 5.0 s                                                                                              |
| 75/s                              | 4020 after 11 s (the burst lasts about 8 s at this rate, then the 3 s flood)                                  |
| 61/s                              | Not kicked in 12 s; excess dropped one a second (the quiet gap resets the streak). Accepted rate stays ≤ 60/s |
| 59/s, and `ready` toggles at 59/s | Not kicked (within the limit, as designed)                                                                    |
| 1 PING, 1 ROOM_REQUEST            | 4002 at once                                                                                                  |

The bystander stayed connected in every case.

**18. Connection and join floods. PASS (see P3, P4).**

- `maxClients = 8 + 4` (`HoldRoom.ts:103`). `onJoin` caps players at 8 synchronously (`:321-323`), and
  one seat per LAN address (`:325-329`, `tuning.ts` `maxSeatsPerAddress: 1`).
- `joinById` is limited to 2 per 5 s per address (`guard.ts:68-69`).
- Live (`t2-seats.mjs`): a second seat from one address got "This laptop is already in the game." That
  held even while the first seat was half-joined.
- Live (`t6-connflood.mjs`): 5,000 sockets from one address, each holding about 15 KB of unfinished
  headers, cost about 97 MB of RSS. Node's 60 s `headersTimeout` frees them. Meanwhile a player from the
  other address joined in 24 ms, and the host's `/api/lan` answered.

**19. Memory cannot grow without bound. PASS.**

- `onLeave` cleans `net`, `seatIps`, `ackTimers`, `bytesAtPerf`, `reports`, `leaveReasons` and `hosts`
  (`HoldRoom.ts:340-366`). Refused joins leave nothing, since `trackClient` runs only after the checks
  (`:331`).
- `KickCooldown` and `ReservationLimiter` forget expired addresses (`validation.ts:285-288, 387-391`).
- Pools are fixed. A half-joined client can't queue replies any more: it may send only the ack or LEAVE,
  and it is closed after 5 s (`HoldRoom.ts:405-411`).
- Live (`t12-earlier.mjs r1`): the earlier repro (200/s 15 KB ROOM_REQUEST frames, never acking JOIN) was
  closed after its first frame. RSS was unchanged (191.0 → 191.0 MB).

**20. A slow or stalled client can't stall the simulation. PASS.**
Sends are asynchronous. Live, during a run (`t4-slow.mjs`, `t12-earlier.mjs o1`):

- A full stall was removed from the room 6.5 s later, by the ws heartbeat.
- A trickle reader kept up, and RSS stayed flat for 60 s.
- A stall that keeps sending unsolicited pongs stayed connected for 60 s. Its backlog lived in the kernel
  socket buffers: server Send-Q 0 to 148 bytes, RSS flat at about 192 MB. Past 1 MB of user-space backlog,
  `dropStalledReaders` drops it (`HoldRoom.ts:456-461`). ws computes `bufferedAmount` from the real socket
  queue.

In every case the bystander kept playing, and the room tick never waited.

### Host-added bots and client perf reports

**21. `addBot` / `removeBots`. PASS.**
Both are host-only and lobby-only (`HoldRoom.ts:255-266, 480-484`). `addBot` is refused when players plus
pending tickets reach 8 (`:484`). Human joins count pending tickets as taken (`:321-323`). The 8-player
check is synchronous in `onJoin`, so no burst overshoots it. Bots join over loopback, so the seat rule
doesn't count them against the host laptop. `tests/integration/hostbots.test.ts` passes.

**22. Bot tickets. PASS.**
A ticket is `randomUUID()`, works once and expires after 10 s (`tickets.ts:24-59`). Any type is safe
(`:33`). Live, `{"length":1}` and an unknown UUID fell through to a normal join or were refused for the
name. Being a bot sets only `PlayerState.bot` and the log's `bots` list.

**23. The bot child process. PASS.**
It is forked only from `addBot`, one per room (`HoldRoom.ts:489`), with a fixed entry and `execArgv`
(`server/src/bots/supervisor.ts:40-46`). It is stopped:

- when the last bot leaves (`HoldRoom.ts:359, 509-515`);
- when the last host page leaves (`:352`);
- on dispose (`:373`);
- by SIGKILL 2 s after `stop` (`supervisor.ts:28-37`).

On IPC disconnect it exits (`server/src/bots/process.ts:41`). IPC carries only `botUrl` (from the server's
own listen address, `index.ts:13-16`), the room code, the generated name, a counter seed and the ticket
(`HoldRoom.ts:493`).

**24. Perf reports. PASS (see P1).**
Exact keys, a known tier and bounded finite numbers (`validation.ts:62-76`). Accepted only from a player
during a run, at most one per 5 s, latest kept, cleared at run start and on leave (`HoldRoom.ts:268-278,
349, 610`). Report values are numbers and the tier is an enum, so they can't break a line.

### Logs and personal data

**25. Names only; logs on the host. PASS.**
Events carry names, the code, the seed, waves and perf numbers (`format.ts:74-109`). Live, none of the 13
logs from this audit contain an IP address (`192.168`, `172.16`, `127.0.0`) or a session id. Logs go to
`./logs` or `LOG_DIR` (`server/src/log/MatchLog.ts:10-12`). Docker mounts `./logs:/app/logs`.

## Findings

### N1 (low): the look-alike check misses ASCII I/l and several common scripts

**Where.** `nameSkeleton` (`shared/rules/validation.ts:241-245`) folds NFKC, lower case and
default-ignorables. It then maps only the ~37 Cyrillic and Greek letters, plus dotless ı, in `CONFUSABLE`
(`:195-237`). Pure-ASCII look-alikes are not folded:

- capital `I` against small `l`;
- the digit `1` against `l`;
- `0` against `O`;
- `rn` against `m`.

Nor are Armenian (`օ` U+0585), Cherokee (`ᎪᏞᏆᏟᎬ`), Latin small capitals (`ᴀʟɪᴄᴇ`) or Latin alpha (`ɑ`
U+0251). The game's fonts are Barlow and Teko (`client/src/style.css:11-12`), and both draw `I` and `l` as
the same plain bar.

**Reproduction.**

- Live (`t8-names-live.mjs`): `192.168.1.11` joins as `Alice`, then `172.16.0.2` joins as `AIice` (capital
  i). The lobby state holds `"Alice"` and `"AIice"`, with no suffix.
- Offline (`npx tsx t7-names.ts`): `uniqueName` against `["Alice", "Bob"]` leaves these unchanged:
  `AIice`, `A1ice`, `ᴀʟɪᴄᴇ`, `ᎪᏞᏆᏟᎬ`, `ɑlice` and `Bօb`.
- For comparison, `Аlice`, `Ａｌｉｃｅ`, `𝐀𝐥𝐢𝐜𝐞` and `Alıce` do get ` 2`.

**Impact.** This is the impersonation R3 was about: two lobby and host-page rows read "Alice", and the host
can kick the wrong one. The ASCII variant needs no special input, so it's the easiest one to use. No code
runs, the logs stay valid, and each player still has a distinct string, so this stays low.

**Proposed fix.** Generate the fold table from Unicode's `confusables.txt` (UTS #39) rather than growing it
by hand:

1. A tool script, for example `tools/confusables.mjs`, writes `shared/rules/confusables.ts`. Keep the
   entries whose prototype is ASCII or a short ASCII sequence: about 2,000 entries, a few tens of KB, server
   only.
2. Apply it as the UTS #39 skeleton (NFD, map, NFD) before lower-casing. `I` and `l` then meet as `l`.
3. If a data file is too much for now, the smallest useful step is an ASCII pre-fold before lower-casing:
   `I`, `1` and `|` to `l`, `0` to `o`, `rn` to `m`, `vv` to `w`. Add Armenian `օ`/`ո`, Cherokee capitals,
   the small capitals and `ɑ` to the map.

The trade-off: `Ian` and `lan` would then count as the same name, but the only effect is a ` 2` suffix,
and nobody is refused. Record the choice in NOTES.md.

**Regression test.** Extend the table in `tests/regression/name-lookalikes.test.ts`:

- `uniqueName(x, ['Alice'])` gives `x + ' 2'` for `AIice`, `A1ice`, `ᴀʟɪᴄᴇ`, `ɑlice` and `ᎪᏞᏆᏟᎬ`;
- `uniqueName('Bօb', ['Bob'])` gives `'Bօb 2'`;
- `uniqueName('rnike', ['mike'])` gets a suffix;
- the existing "two different real names never collide" case still passes.

## Observations (not findings)

- **P1. A player named `__proto__` is missing from the perf line.** `writePerf` builds `kBps` and `clients`
  as `{}` keyed by name (`HoldRoom.ts:629, 644-648`). Live, the `perf` line had `players: 2`, but `kBps`
  and `clients` held only `Normal`. The line stays valid JSON and nothing else is affected. It is already
  listed as open in NOTES.md (2026-11-08). A fix is cheap: `Object.create(null)` maps, which
  `JSON.stringify` writes with a real `"__proto__"` key. A test would run a match with that name and check
  that the key is present.
- **P2. Emoji tag characters are kept after any character**, not only after U+1F3F4 (`isAfterBase`,
  `validation.ts:121-126`). `"A"` plus 25 tags is accepted: it shows as "A" and takes 51 of the 64 units.
  The skeleton strips them, so `A`+tags next to `A` gets a suffix and impersonation is still caught. It is
  only a hidden-text carrier. You could keep tags only in a flag sequence.
- **P3. A kicked address can still make HTTP reservations.** Live: 200 at `joinById` while blocked. The
  WebSocket leg is then refused, but each reservation holds one of the 12 `maxClients` slots for 5 s. One
  laptop holds at most 1 seat plus 2 reservations, so two colluding laptops can cost the lobby about 1 seat.
  Bounded; you could check the cooldown in the guard too.
- **P4. Per-address rules key on the socket address string.** A laptop with root on its own machine can add
  IPv4 aliases and get one seat per alias. If `BIND_HOST` were set to `::`, IPv4 clients would appear as
  `::ffff:a.b.c.d` and IPv6 privacy addresses as separate laptops. This is inherent to address-based limits;
  for audit 3.
- **P5. Regression from the one-seat rule: a Wi-Fi blip locks a player out for a few seconds.** After a clean
  leave or a reset, the same laptop rejoined at once. After a silent drop, the old socket lives until the
  heartbeat reaps it (6.5 s measured for a stalled socket, 6 to 9 s by design, `WebSocketTransport.mjs:158-171`).
  Until then the rejoin gets "This laptop is already in the game." The join screen doesn't auto-retry that
  error (`client/src/net/joinflow.ts:45`, `retryMs: null`). NOTES.md already flags this for 1f
  (reconnect). A `retryMs` on `oneSeat` would hide it.
- **P6. Each malformed msgpack frame prints a full stack trace** to the server console (`RoomMessages.mjs:128`).
  The client is closed and rejoins are limited to 2 per 5 s, so the noise is bounded.
- **P7. The frame gate wraps a Colyseus internal** (`Room._onMessage`, `HoldRoom.ts:135-146`). The
  dependencies are caret ranges (`server/package.json`: `^0.18.25`), so `npm update` could change it.
  `tests/regression/half-join.test.ts` catches that, as long as tests run after every update. You could pin
  exact versions.
- **P8. Connection floods** (checklist 18 above): 5,000 half-open requests cost about 97 MB until the 60 s
  `headersTimeout` frees them. There is no per-address connection cap; for audit 3.
- **P9. Still parked for audit 3:** O2 (no Origin check, so a web page in the host's own browser can act as
  host), O3 (binds `0.0.0.0`), O4 (`/api/lan` lists Docker bridge and VPN addresses).

---

## Earlier findings: fixed or not

_Written after the checklist above was complete._

| Earlier item                                                                      | Status now          | Evidence                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1** Host takeover with a forged IP header (high)                               | **Fixed**           | `guard.ts:41-50, 75-79` strips the three headers Colyseus reads (`Transport.mjs:48-51`) on every request and upgrade. Live: `role:"host"` from LAN with six forged headers on both legs was refused; LAN `start`/`kick`/`addBot`/`restart` had no effect (`t1-trust.mjs`). `host-spoof.test.ts` passes.                                                                                                        |
| **F2** LAN room creation and unbounded matchmaking body (medium)                  | **Fixed**           | `matchmakeGate` (`validation.ts:357-368`) plus `guard.ts:53-71`. Live: LAN `create`, all other methods and odd paths refused; 17 KB body 413, chunked and no-length 411, `+15`, duplicate and CL+TE lengths 400, pipelined `create` 403 (`t1-trust.mjs`, `t5-http.mjs`, `t5b.mjs`). A 16 KB body just under the cap was answered and the name cut to 16.                                                       |
| **F3** PING, input and request frames skip the token bucket (medium)              | **Fixed**           | `gateFrame` (`HoldRoom.ts:418-433`): those frames now close the client. Live, joined, just under the cap: PING and ROOM_REQUEST at 200/s closed at the first frame (4002); ROOM_DATA at 239/s kicked with 4020 after 3.7 s (`t12-earlier.mjs f3`, `t3-flood.mjs`).                                                                                                                                             |
| **F4** Half-joined socket buffers replies without bound (medium)                  | **Fixed**           | Before the ack only JOIN_ROOM and LEAVE_ROOM are allowed (`HoldRoom.ts:60, 429-430`), and an un-acked client is closed after 5 s (`:405-411`). Live: closed 4.8 s after joining without an ack (seat freed); ROOM_DATA before the ack closed at once (`t2-seats.mjs`).                                                                                                                                         |
| **F5** U+2028/U+2029 in names reach the log (low)                                 | **Fixed**           | `STRIP` includes Zl/Zp/Cc (`validation.ts:118`). Offline `a b` and `a\u0085b` became `ab`. `name-separators.test.ts` passes.                                                                                                                                                                                                                                                                                   |
| **R1** Half-joined socket grows memory; PING and requests skip the bucket (high)  | **Fixed**           | Same gate and ack timer as F3/F4. Live, the exact R1 repro (half-joined, 200/s, 15 KB ROOM_REQUEST types) was closed after its first frame, RSS 191.0 → 191.0 MB (was +123 MB in 40 s). `half-join.test.ts` passes and floods under the cap.                                                                                                                                                                   |
| **R2** One address holds every seat; kicked squatters come straight back (medium) | **Fixed**           | One seat per LAN address (`HoldRoom.ts:325-329`) and a 60 s kick cooldown checked at WebSocket time (`:300-301`, `:247-249`). Live: 2nd seat refused (also while the first was half-joined); after a kick, rejoin refused with "You were removed by the host. Try again in a minute."; the other address joined normally (`t2-seats.mjs`). See P3 and P5.                                                      |
| **R3** Look-alike, blank and malformed names (low)                                | **Fixed, one gap**  | Every R3 repro now behaves: `Alice‍`/`Al‌ice`/Cyrillic `е` get ` 2`; NFD is stored as NFC; Hangul filler and braille blanks are refused; `A\uD800B` is refused (live: `\ud800Bob` refused); 900 marks are cut to 4, at most 64 units. Gap: ASCII and other-script look-alikes, now **N1**.                                                                                                                     |
| **O1** Stalled client that keeps sending pongs is never dropped                   | **Fixed (bounded)** | `dropStalledReaders` on every timestep (`HoldRoom.ts:285-288, 456-461`), limit 1 MB. Live, a stalled reader that keeps sending pongs stayed connected for 60 s with RSS flat; its backlog was in kernel buffers and never reached the 1 MB user-space limit, so the drop itself was proven only by `slow-reader.test.ts` (faked `bufferedAmount`). A stall without pongs was reaped by the heartbeat in 6.5 s. |

**Regressions from the fixes.**

- **Normal play.** It works: an SDK player from a LAN address sent 298 inputs at 20/s for 15 s, and 296
  were applied with no drop (`t11-normal.mjs`). The SDK never sends PING or requests in our flow.
- **Legit names.** They are kept as typed (`t7-names.ts`): emoji families, flags, keycaps, skin tones,
  ZWJ/ZWNJ in Devanagari and Persian, Hindi, Thai, Korean and NFD Vietnamese. The only change: 20 family
  emoji now stop at 5, because of the 64-unit cap (recorded in NOTES.md).
- **Host.** The host is not limited. Loopback is exempt from the seat and kick rules (`HoldRoom.ts:187-190`).
  Host commands worked live, and bots join over loopback.
- **New friction**, recorded above: the lockout after a silent drop (P5), and a 60 s wait after a mistaken
  kick (decided in NOTES.md).

**Tests, lint and typecheck on the audited tree.**

- `npm test`: 42 files, 372 tests, all pass, `tests/regression/` included.
- `npm run lint` (ESLint plus Prettier): clean.
- `npm run typecheck`: clean.
- I did not run `npm run test:e2e`: it rebuilds `client/dist`, which the user's own server on 2567 serves.

## Overall verdict

**Audit 1 passes on everything that matters: no high or medium finding remains.** Every earlier finding is
fixed, and the fixes hold just under every cap as well as above it. One low finding, N1 (ASCII and
other-script look-alike names), is still open. Under BRIEF.md's rule ("an audit finding is fixed with a
regression test before the next stage starts"), audit 1 closes when N1 is either:

- fixed, with the regression rows above; or
- recorded in NOTES.md by JCCJ as an accepted limit of the look-alike check.

P1 (the `__proto__` perf key) is cheap and worth fixing at the same time.

## Fixed (2026-11-09)

| Item      | Fix                                                                                                                                                                                | Regression test                                                                    |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| N1        | `nameSkeleton` folds i/I/l/1/\| to l and 0 to o, plus Armenian, Latin small capitals, alpha, script g, Cherokee capitals, `rn` → m and `vv` → w. Live: `AIice` joins as `AIice 2`. | `tests/regression/name-lookalikes.test.ts` (13 new rows, plus never-collide cases) |
| P1        | The perf line's `kBps` and `clients` are null-prototype maps.                                                                                                                      | `tests/integration/matchlog.test.ts` ("a player named **proto**…")                 |
| P5        | `oneSeat` auto-retries every `joinRetryMs`.                                                                                                                                        | `tests/unit/client/joinflow.test.ts`                                               |
| Bot names | `nextBotName` uses the same skeleton.                                                                                                                                              | `tests/unit/server/bots.test.ts`                                                   |
