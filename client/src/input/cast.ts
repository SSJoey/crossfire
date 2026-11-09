import { HERO_IDS, type HeroId } from '@crossfire/shared/heroes';
import type { CastId } from '@crossfire/shared/types';

/**
 * Q and E as one-shot casts (NOTES.md 2026-11-09, 1b.2 default 4). Q is held to preview and
 * cast on release; E casts on press. Presses between two inputs are latched, so a quick tap
 * is never lost; Q goes out before E when both land in the same tick.
 */
export class CastLatch {
  private held = false;
  private eDown = false;
  private q = false;
  private e = false;

  /** Q is held (zone preview). */
  get qHeld(): boolean {
    return this.held;
  }

  keyDown(code: string, repeat: boolean): void {
    if (code === 'KeyQ') this.held = true;
    else if (code === 'KeyE' && !repeat && !this.eDown) {
      this.eDown = true;
      this.e = true;
    }
  }

  keyUp(code: string): void {
    if (code === 'KeyQ' && this.held) {
      this.held = false;
      this.q = true;
    } else if (code === 'KeyE') this.eDown = false;
  }

  /** Window blur or hidden tab: a held Q is cancelled, latched casts are dropped. */
  cancel(): void {
    this.held = false;
    this.eDown = false;
    this.q = false;
    this.e = false;
  }

  /**
   * The cast for the next input. Not standing drops everything; an E the predictor says is
   * not ready is dropped (the server would refuse it, and the prediction would snap back).
   */
  take(standing: boolean, eReady: boolean): CastId {
    if (!standing) {
      this.q = false;
      this.e = false;
      return 'none';
    }
    if (this.q) {
      this.q = false;
      return 'q';
    }
    if (this.e) {
      this.e = false;
      return eReady ? 'e' : 'none';
    }
    return 'none';
  }
}

/** The debug hero switch (1 to 4) needs `?debug=1` on the page (and CROSSFIRE_DEBUG on the server). */
export function debugEnabled(search: string): boolean {
  return new URLSearchParams(search).get('debug') === '1';
}

const DIGITS = ['Digit1', 'Digit2', 'Digit3', 'Digit4'];

/** The hero a debug key switches to, or null. */
export function debugHeroKey(code: string, debug: boolean): HeroId | null {
  if (!debug) return null;
  const i = DIGITS.indexOf(code);
  return i >= 0 ? HERO_IDS[i]! : null;
}
