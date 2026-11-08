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

// Control characters (U+0085 next line among them), invisible format characters (including
// bidi overrides and isolates) and the line and paragraph separators U+2028 / U+2029 (Zl, Zp:
// JSON.stringify leaves them raw, and some log readers break lines on them; audit 1, F5),
// except the zero-width joiner and non-joiner that emoji and some scripts need.
const STRIP = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;
const KEEP_FORMAT = new Set(['‌', '‍']);
const VISIBLE = /[\p{L}\p{N}\p{S}\p{P}]/u;

export type NameResult = { ok: true; name: string } | { ok: false };

/** Cleans an untrusted player name. The result is plain text, to be rendered with textContent only. */
export function sanitizeName(raw: unknown, maxLength = TUNING.lobby.maxNameLength): NameResult {
  if (typeof raw !== 'string') return { ok: false };
  // Bound work on absurd input before segmenting.
  const bounded = raw.slice(0, maxLength * 64);
  const cleaned = bounded.replace(STRIP, (c) => (KEEP_FORMAT.has(c) ? c : '')).trim();
  const name = takeGraphemes(cleaned, maxLength).trim();
  if (!VISIBLE.test(name)) return { ok: false };
  return { ok: true, name };
}

/** Adds " 2", " 3"… when the name is taken (case-insensitive), staying within the length cap. */
export function uniqueName(
  name: string,
  existing: Iterable<string>,
  maxLength = TUNING.lobby.maxNameLength,
): string {
  const taken = new Set<string>();
  for (const e of existing) taken.add(e.toLowerCase());
  if (!taken.has(name.toLowerCase())) return name;
  for (let n = 2; ; n++) {
    const suffix = ` ${n}`;
    const base = takeGraphemes(name, maxLength - suffix.length).trimEnd();
    const candidate = base + suffix;
    if (!taken.has(candidate.toLowerCase())) return candidate;
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
