import { el, setText } from '../dom';
import { FpsStats } from './fpsStats';

/** The fps overlay is shown only with `?fps=1` in the page address. */
export function fpsEnabled(search: string): boolean {
  return new URLSearchParams(search).get('fps') === '1';
}

const REFRESH_MS = 500;

/** Corner readout for checking the performance budget: fps, 1% low, enemies, tier. */
export class FpsOverlay {
  readonly root = el('div', {
    id: 'fps-overlay',
    className: 'fps-overlay',
    attrs: { 'aria-hidden': 'true' },
  });
  private readonly stats = new FpsStats(600);
  private sinceRefresh = 0;

  frame(frameMs: number, enemies: number, tier: string): void {
    this.stats.add(frameMs);
    this.sinceRefresh += frameMs;
    if (this.sinceRefresh < REFRESH_MS) return;
    this.sinceRefresh = 0;
    const fps = Math.round(this.stats.fps());
    const low = Math.round(this.stats.low1());
    setText(this.root, `${fps} fps · 1% low ${low} · enemies ${enemies} · ${tier}`);
  }
}
