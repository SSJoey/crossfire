import { TUNING } from '@crossfire/shared/tuning';
import type { GfxTier, PerfReport } from '@crossfire/shared/types';
import { FpsStats } from '../hud/fpsStats';

function round(v: number, decimals: number): number {
  const f = 10 ** decimals;
  return Math.round(v * f) / f;
}

function clamp(v: number, min: number, max: number): number {
  return v < min ? min : v > max ? max : v;
}

/** 10 s of frames at 240 Hz. */
const FRAME_CAPACITY = 2400;

/**
 * Builds this client's performance report for the match log: every `intervalMs` of a run,
 * the average fps and the 1% low over that interval's frames, the tier and the canvas size.
 * Slow frames count, so a browser below 1 fps shows up as slow. Skipped: the one gap frame after
 * the tab was hidden (`hidden()`), and any frame longer than `maxFrameMs` (a sleeping or frozen
 * machine that sent no visibility event). No allocation per frame; one small object per report.
 */
export class PerfReporter {
  private readonly stats = new FpsStats(FRAME_CAPACITY);
  private elapsedMs = 0;
  private frames = 0;
  private skipNext = false;

  constructor(
    private readonly intervalMs = TUNING.log.clientReportSec * 1000,
    private readonly lim = TUNING.log,
  ) {}

  /** The tab was hidden: the next frame spans the hidden time and is not counted. */
  hidden(): void {
    this.skipNext = true;
  }

  /** Call once per rendered frame. Returns a report when one is due, otherwise null. */
  frame(
    frameMs: number,
    running: boolean,
    tier: GfxTier,
    w: number,
    h: number,
    dpr: number,
  ): PerfReport | null {
    if (!running) {
      this.elapsedMs = 0;
      this.frames = 0;
      this.skipNext = false;
      return null;
    }
    if (this.skipNext) {
      this.skipNext = false;
      return null;
    }
    if (!(frameMs > 0) || frameMs > this.lim.maxFrameMs) return null;
    this.stats.add(frameMs);
    this.elapsedMs += frameMs;
    this.frames++;
    if (this.elapsedMs < this.intervalMs - 1e-6) return null;
    const fps = (this.frames * 1000) / this.elapsedMs;
    const low1 = this.stats.low1(this.frames);
    this.elapsedMs = 0;
    this.frames = 0;
    return {
      tier,
      fps: round(clamp(fps, 0, this.lim.maxReportFps), 1),
      low1: round(clamp(low1, 0, this.lim.maxReportFps), 1),
      w: clamp(Math.round(w), 1, this.lim.maxCanvasPx),
      h: clamp(Math.round(h), 1, this.lim.maxCanvasPx),
      dpr: round(clamp(dpr, this.lim.minDpr, this.lim.maxDpr), 2),
    };
  }
}
