/** Keys the game reads, by KeyboardEvent.code (layout independent). */
const USED = new Set([
  'KeyW',
  'KeyA',
  'KeyS',
  'KeyD',
  'KeyF',
  'KeyQ',
  'KeyE',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Escape',
]);

export function isGameKey(code: string): boolean {
  return USED.has(code);
}

/** Esc asks to pause the run (stage 1b.3): once per press, never on a held key's repeat. */
export function isPauseKey(code: string, repeat: boolean): boolean {
  return code === 'Escape' && !repeat;
}

/**
 * Held keys and the move vector they make. The camera never rotates and looks towards −Z,
 * so "up" on screen (W) is −Z and "right" (D) is +X.
 */
export class KeyState {
  private readonly held = new Set<string>();

  down(code: string): void {
    if (USED.has(code)) this.held.add(code);
  }

  up(code: string): void {
    this.held.delete(code);
  }

  isDown(code: string): boolean {
    return this.held.has(code);
  }

  /** Releases everything (window blur, tab hidden). */
  clear(): void {
    this.held.clear();
  }

  move(out: { x: number; z: number }): void {
    const h = this.held;
    let x = 0;
    let z = 0;
    if (h.has('KeyW') || h.has('ArrowUp')) z -= 1;
    if (h.has('KeyS') || h.has('ArrowDown')) z += 1;
    if (h.has('KeyA') || h.has('ArrowLeft')) x -= 1;
    if (h.has('KeyD') || h.has('ArrowRight')) x += 1;
    const len = Math.hypot(x, z);
    out.x = len > 0 ? x / len : 0;
    out.z = len > 0 ? z / len : 0;
  }
}

/** Input sequence numbers: start at 1 and increase with every input sent. */
export class InputSeq {
  private n = 0;

  next(): number {
    this.n = (this.n + 1) % 2 ** 31;
    return this.n;
  }
}
