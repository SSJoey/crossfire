import { TUNING } from '../tuning';
import { GFX_TIERS, JOIN_ERRORS, type GfxTier, type InputMessage, type PerfReport } from '../types';

const INPUT_KEYS = ['seq', 'moveX', 'moveZ', 'aimX', 'aimZ', 'attack', 'revive'] as const;
const MAX_SEQ = 2 ** 31 - 1;

function finiteInRange(v: unknown, maxAbs: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Math.abs(v) <= maxAbs;
}

/**
 * Validates an untrusted input payload. Returns a clean copy, or null to drop it.
 * Rules: exactly the known keys; numbers finite and within ±maxAbsNumber; booleans are booleans;
 * the move vector is clamped to length 1; the aim point is clamped to the map.
 */
export function sanitizeInput(raw: unknown, net = TUNING.net, ring = TUNING.ring): InputMessage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== INPUT_KEYS.length) return null;
  const o = raw as Record<string, unknown>;
  for (const k of INPUT_KEYS) if (!Object.hasOwn(o, k)) return null;

  const { seq, moveX, moveZ, aimX, aimZ, attack, revive } = o;
  if (typeof seq !== 'number' || !Number.isInteger(seq) || seq < 0 || seq > MAX_SEQ) return null;
  if (!finiteInRange(moveX, net.maxAbsNumber) || !finiteInRange(moveZ, net.maxAbsNumber)) return null;
  if (!finiteInRange(aimX, net.maxAbsNumber) || !finiteInRange(aimZ, net.maxAbsNumber)) return null;
  if (typeof attack !== 'boolean' || typeof revive !== 'boolean') return null;

  let mx = moveX;
  let mz = moveZ;
  const len = Math.hypot(mx, mz);
  if (len > 1) {
    mx /= len;
    mz /= len;
  }
  let ax = aimX;
  let az = aimZ;
  const ad = Math.hypot(ax, az);
  if (ad > ring.mapRadius) {
    ax *= ring.mapRadius / ad;
    az *= ring.mapRadius / ad;
  }
  return { seq, moveX: mx, moveZ: mz, aimX: ax, aimZ: az, attack, revive };
}

const PERF_KEYS = ['tier', 'fps', 'low1', 'w', 'h', 'dpr'] as const;

function inRange(v: unknown, min: number, max: number): v is number {
  return typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;
}

function roundTo(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

/**
 * Validates an untrusted client performance report. Returns a clean copy, or null to drop it.
 * Rules: exactly the known keys; a known tier; fps and 1% low within 0..maxReportFps;
 * whole-pixel canvas sizes within 1..maxCanvasPx; pixel ratio within minDpr..maxDpr.
 */
export function sanitizePerfReport(raw: unknown, lim = TUNING.log): PerfReport | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const keys = Object.keys(raw);
  if (keys.length !== PERF_KEYS.length) return null;
  const o = raw as Record<string, unknown>;
  for (const k of PERF_KEYS) if (!Object.hasOwn(o, k)) return null;

  const { tier, fps, low1, w, h, dpr } = o;
  if (!(GFX_TIERS as readonly unknown[]).includes(tier)) return null;
  if (!inRange(fps, 0, lim.maxReportFps) || !inRange(low1, 0, lim.maxReportFps)) return null;
  if (!inRange(w, 1, lim.maxCanvasPx) || !Number.isInteger(w)) return null;
  if (!inRange(h, 1, lim.maxCanvasPx) || !Number.isInteger(h)) return null;
  if (!inRange(dpr, lim.minDpr, lim.maxDpr)) return null;
  return { tier: tier as GfxTier, fps: roundTo(fps, 1), low1: roundTo(low1, 1), w, h, dpr: roundTo(dpr, 2) };
}

/** True when `seq` is newer than the last applied input. */
export function acceptSeq(lastSeq: number, seq: number): boolean {
  return seq > lastSeq;
}

/** True when the last input is too old: the hero is treated as standing still. */
export function isStale(lastInputMs: number, nowMs: number, staleMs = TUNING.net.staleInputMs): boolean {
  return nowMs - lastInputMs > staleMs;
}

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** Number of visible characters (grapheme clusters): one emoji counts as 1. */
export function graphemeLength(s: string): number {
  let n = 0;
  for (const _ of segmenter.segment(s)) n++;
  return n;
}

function takeGraphemes(s: string, max: number): string {
  let out = '';
  let n = 0;
  for (const { segment } of segmenter.segment(s)) {
    if (n >= max) break;
    out += segment;
    n++;
  }
  return out;
}

// Characters a name may not contain:
// - control characters (U+0085 next line among them);
// - invisible format characters, including bidi overrides and isolates;
// - the line and paragraph separators U+2028 / U+2029 (Zl, Zp: JSON.stringify leaves them raw,
//   and some log readers break lines on them; audit 1, F5);
// - default-ignorable characters (render as nothing: Hangul fillers and the like; audit 1, R3);
// - U+2800, the blank braille pattern (renders blank).
// Exceptions, so emoji and real scripts keep working (see `keepJoiners`):
// - the zero-width joiner and non-joiner, between two kept characters;
// - variation selectors and emoji tag characters, right after a kept character.
const STRIP = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Default_Ignorable_Code_Point}\u{2800}]/u;
const JOINER = /^[\u{200C}\u{200D}]$/u;
/** Variation selectors and emoji tag characters: they modify the character before them. */
function isAfterBase(c: string): boolean {
  const cp = c.codePointAt(0) ?? 0;
  return (
    (cp >= 0xfe00 && cp <= 0xfe0f) || (cp >= 0xe0020 && cp <= 0xe007f) || (cp >= 0xe0100 && cp <= 0xe01ef)
  );
}
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;
const MARK = /^\p{M}$/u;

/** Removes forbidden characters, keeping joiners and selectors only where they join something. */
function keepJoiners(s: string): string {
  const cps = [...s];
  const out: string[] = [];
  const plain = (c: string | undefined) => c !== undefined && !STRIP.test(c);
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i]!;
    if (!STRIP.test(c)) out.push(c);
    else if (JOINER.test(c)) {
      const prev = out[out.length - 1];
      if (plain(prev) || (prev !== undefined && isAfterBase(prev))) {
        // Keep it only if a plain character follows (skipping its own selectors).
        let j = i + 1;
        while (j < cps.length && isAfterBase(cps[j]!)) j++;
        if (plain(cps[j])) out.push(c);
      }
    } else if (isAfterBase(c) && out.length > 0 && !JOINER.test(out[out.length - 1]!)) out.push(c);
  }
  return out.join('');
}

/** Keeps at most `maxMarks` combining marks in one grapheme. */
function capMarks(segment: string, maxMarks: number): string {
  let marks = 0;
  let out = '';
  for (const c of segment) {
    if (MARK.test(c) && ++marks > maxMarks) continue;
    out += c;
  }
  return out;
}

export type NameResult = { ok: true; name: string } | { ok: false };

/**
 * Cleans an untrusted player name. The result is plain text, to be rendered with textContent only:
 * well-formed, NFC, without invisible characters, at most `maxLength` graphemes, at most
 * `maxMarksPerGrapheme` combining marks per grapheme and at most `maxNameUnits` UTF-16 units.
 */
export function sanitizeName(
  raw: unknown,
  maxLength = TUNING.lobby.maxNameLength,
  lim = TUNING.lobby,
): NameResult {
  if (typeof raw !== 'string' || !raw.isWellFormed()) return { ok: false };
  // Bound work on absurd input before normalising and segmenting.
  const cleaned = keepJoiners(raw.slice(0, maxLength * 64).normalize('NFC')).trim();
  let name = '';
  let n = 0;
  for (const { segment } of segmenter.segment(cleaned)) {
    if (n >= maxLength) break;
    const seg = capMarks(segment, lim.maxMarksPerGrapheme);
    if (name.length + seg.length > lim.maxNameUnits) break;
    name += seg;
    n++;
  }
  name = name.trim();
  if (!VISIBLE.test(name)) return { ok: false };
  return { ok: true, name };
}

/**
 * Latin look-alikes, in lower case (the skeleton lower-cases first). A small hand-written table
 * (JCCJ, 2026-11-09), not the full Unicode confusables list. Only for comparing names; nothing is
 * ever displayed through it.
 */
const CONFUSABLE: Readonly<Record<string, string>> = Object.freeze({
  // ASCII. i, I, l, 1 and | all meet as l: capital I and l look the same in the game fonts, and names compare
  // ignoring case, so i has to join them too (JCCJ, 2026-11-09).
  '\u0069': 'l',
  '\u0031': 'l',
  '\u007c': 'l',
  '\u0030': 'o',
  // Cyrillic
  '\u0430': 'a',
  '\u0432': 'b',
  '\u0435': 'e',
  '\u0455': 's',
  '\u0456': 'l',
  '\u0458': 'j',
  '\u043a': 'k',
  '\u043c': 'm',
  '\u043d': 'h',
  '\u043e': 'o',
  '\u0440': 'p',
  '\u0441': 'c',
  '\u0442': 't',
  '\u0443': 'y',
  '\u0445': 'x',
  '\u04bb': 'h',
  '\u0501': 'd',
  '\u051b': 'q',
  '\u051d': 'w',
  '\u04cf': 'l',
  '\u04af': 'y',
  '\u0475': 'v',
  // Greek
  '\u03b1': 'a',
  '\u03b2': 'b',
  '\u03b5': 'e',
  '\u03b6': 'z',
  '\u03b7': 'h',
  '\u03b9': 'l',
  '\u03ba': 'k',
  '\u03bc': 'm',
  '\u03bd': 'n',
  '\u03bf': 'o',
  '\u03c1': 'p',
  '\u03c4': 't',
  '\u03c5': 'y',
  '\u03c7': 'x',
  '\u03f2': 'c',
  // Armenian
  '\u0585': 'o',
  '\u0578': 'n',
  '\u057d': 'u',
  '\u0570': 'h',
  '\u0581': 'g',
  '\u0566': 'q',
  // Latin: dotless i, alpha, script g, small capitals
  '\u0131': 'l',
  '\u0251': 'a',
  '\u0261': 'g',
  '\u1d00': 'a',
  '\u0299': 'b',
  '\u1d04': 'c',
  '\u1d05': 'd',
  '\u1d07': 'e',
  '\u0262': 'g',
  '\u029c': 'h',
  '\u026a': 'l',
  '\u1d0a': 'j',
  '\u1d0b': 'k',
  '\u029f': 'l',
  '\u1d0d': 'm',
  '\u0274': 'n',
  '\u1d0f': 'o',
  '\u1d18': 'p',
  '\u0280': 'r',
  '\ua731': 's',
  '\u1d1b': 't',
  '\u1d1c': 'u',
  '\u1d20': 'v',
  '\u1d21': 'w',
  '\u028f': 'y',
  '\u1d22': 'z',
});

/**
 * Cherokee capitals that look like Latin letters. `toLowerCase` turns them into Cherokee small
 * letters, so both forms are added to the lookup below.
 */
const CHEROKEE: readonly (readonly [number, string])[] = [
  [0x13a0, 'd'],
  [0x13a1, 'r'],
  [0x13a2, 't'],
  [0x13a9, 'y'],
  [0x13aa, 'a'],
  [0x13ab, 'j'],
  [0x13ac, 'e'],
  [0x13b3, 'w'],
  [0x13b7, 'm'],
  [0x13bb, 'h'],
  [0x13c0, 'g'],
  [0x13c2, 'h'],
  [0x13c3, 'z'],
  [0x13c6, 'l'],
  [0x13cf, 'b'],
  [0x13d2, 'r'],
  [0x13d4, 'w'],
  [0x13d5, 's'],
  [0x13da, 's'],
  [0x13dd, 'l'],
  [0x13de, 'l'],
  [0x13df, 'c'],
  [0x13e2, 'p'],
  [0x13e6, 'k'],
  [0x13e7, 'd'],
  [0x13f4, 'b'],
];
const FOLD = new Map<string, string>(Object.entries(CONFUSABLE));
for (const [cp, latin] of CHEROKEE) {
  const c = String.fromCodePoint(cp);
  FOLD.set(c, latin);
  FOLD.set(c.toLowerCase(), latin);
}
/** Letter pairs that read as one letter: rn as m, vv as w. */
const PAIRS: readonly (readonly [string, string])[] = [
  ['rn', 'm'],
  ['vv', 'w'],
];
const IGNORABLE = /\p{Default_Ignorable_Code_Point}/gu;

/**
 * What a name looks like, for duplicate checks: NFKC, no invisibles, lower case, look-alikes folded,
 * then rn/vv. Trade-off: some real names meet (Ian and lan, Arnie and Amie); the second gets " 2".
 */
export function nameSkeleton(name: string): string {
  let out = '';
  for (const c of name.normalize('NFKC').replace(IGNORABLE, '').toLowerCase()) out += FOLD.get(c) ?? c;
  for (const [pair, one] of PAIRS) out = out.replaceAll(pair, one);
  return out;
}

/** Adds " 2", " 3"… when a name that looks the same is taken, staying within the length cap. */
export function uniqueName(
  name: string,
  existing: Iterable<string>,
  maxLength = TUNING.lobby.maxNameLength,
): string {
  const taken = new Set<string>();
  for (const e of existing) taken.add(nameSkeleton(e));
  if (!taken.has(nameSkeleton(name))) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const base = takeGraphemes(name, maxLength - suffix.length).trimEnd();
    const candidate = base + suffix;
    if (!taken.has(nameSkeleton(candidate))) return candidate;
  }
}

/** Number of seats `ip` holds in a sessionId → address map. */
export function seatsHeldBy(ip: string, seats: ReadonlyMap<string, string>): number {
  let n = 0;
  for (const a of seats.values()) if (a === ip) n++;
  return n;
}

/** Addresses the host kicked, blocked from rejoining for `ms` (audit 1, R2). Expired ones are forgotten. */
export class KickCooldown {
  private readonly until = new Map<string, number>();

  constructor(public ms = TUNING.lobby.kickCooldownSec * 1000) {}

  get size(): number {
    return this.until.size;
  }

  block(ip: string, nowMs: number): void {
    this.until.set(ip, nowMs + this.ms);
  }

  blocked(ip: string, nowMs: number): boolean {
    for (const [k, t] of this.until) if (nowMs >= t) this.until.delete(k);
    return this.until.has(ip);
  }

  clear(): void {
    this.until.clear();
  }
}

/**
 * Per-client token bucket. Excess messages are dropped. A client whose messages keep being
 * dropped for `floodKickMs` (with no quiet gap longer than `quietMs`) should be kicked.
 */
export class RateLimiter {
  private tokens: number;
  private last: number | null = null;
  private floodStart: number | null = null;
  private lastDrop: number | null = null;

  constructor(
    private readonly ratePerSec = TUNING.net.ratePerSec,
    private readonly burst = TUNING.net.burst,
    private readonly floodKickMs = TUNING.net.floodKickMs,
    private readonly quietMs = TUNING.net.floodQuietMs,
  ) {
    this.tokens = burst;
  }

  allow(nowMs: number): boolean {
    if (this.last !== null && nowMs > this.last) {
      this.tokens = Math.min(this.burst, this.tokens + ((nowMs - this.last) / 1000) * this.ratePerSec);
    }
    if (this.last === null || nowMs > this.last) this.last = nowMs;
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    if (this.floodStart === null || this.lastDrop === null || nowMs - this.lastDrop > this.quietMs) {
      this.floodStart = nowMs;
    }
    this.lastDrop = nowMs;
    return false;
  }

  shouldKick(nowMs: number): boolean {
    if (this.floodStart === null || this.lastDrop === null) return false;
    if (nowMs - this.lastDrop > this.quietMs) return false;
    return nowMs - this.floodStart >= this.floodKickMs;
  }
}

export interface MatchmakeRequest {
  /** The `<method>` in POST /matchmake/<method>/<room>. */
  method: string;
  /** The raw Content-Length header, if any. */
  contentLength: string | undefined;
  /** Sent with Transfer-Encoding (no declared length). */
  chunked: boolean;
  /** From the host laptop's own socket (not from any header). */
  loopback: boolean;
}

export type GateResult = { ok: true } | { ok: false; status: number; error: string };

/** Matchmaking methods the game uses: the host page creates, players join by code. */
const MATCHMAKE_METHODS = new Set(['create', 'joinById']);

/**
 * Decides whether an untrusted matchmaking request may reach Colyseus (audit 1, F2).
 * Only `create` (host laptop only) and `joinById`, with a declared body of at most `maxBodyBytes`.
 */
export function matchmakeGate(
  req: MatchmakeRequest,
  maxBodyBytes = TUNING.net.maxMatchmakeBodyBytes,
): GateResult {
  if (!MATCHMAKE_METHODS.has(req.method)) return { ok: false, status: 403, error: JOIN_ERRORS.notAllowed };
  if (req.method === 'create' && !req.loopback) return { ok: false, status: 403, error: JOIN_ERRORS.notHost };
  if (req.chunked || req.contentLength === undefined)
    return { ok: false, status: 411, error: 'Length required.' };
  if (!/^\d{1,10}$/.test(req.contentLength)) return { ok: false, status: 400, error: 'Bad length.' };
  if (Number(req.contentLength) > maxBodyBytes) return { ok: false, status: 413, error: 'Too large.' };
  return { ok: true };
}

/**
 * At most `max` joins per address within `windowMs` (the seat reservation time), so one LAN
 * laptop cannot hold every seat (audit 1, checklist 18). Idle addresses are forgotten.
 */
export class ReservationLimiter {
  private readonly recent = new Map<string, number[]>();

  constructor(
    private readonly max = TUNING.lobby.maxReservationsPerIp,
    private readonly windowMs = TUNING.lobby.seatReservationSec * 1000,
  ) {}

  /** Number of addresses remembered (for tests). */
  get size(): number {
    return this.recent.size;
  }

  allow(ip: string, nowMs: number): boolean {
    for (const [k, times] of this.recent) {
      while (times.length > 0 && nowMs - times[0]! >= this.windowMs) times.shift();
      if (times.length === 0) this.recent.delete(k);
    }
    const times = this.recent.get(ip) ?? [];
    if (times.length >= this.max) return false;
    times.push(nowMs);
    this.recent.set(ip, times);
    return true;
  }
}

/** True for loopback addresses (the host laptop itself), including IPv4-mapped IPv6. */
export function isLoopbackAddress(ip: unknown): boolean {
  if (typeof ip !== 'string' || ip === '') return false;
  const v4 = ip.startsWith('::ffff:') ? ip.slice(7) : ip;
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4)) return true;
  return ip === '::1' || ip === '0:0:0:0:0:0:0:1';
}
