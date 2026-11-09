import type { HeroId } from '@crossfire/shared/heroes';
import { CastLatch, debugHeroKey } from './cast';
import { isGameKey, isPauseKey, KeyState } from './keys';

/**
 * Keyboard and mouse listeners. Everything is released when the window loses focus or the tab
 * is hidden, so an alt-tabbed player stands still instead of running off.
 */
export class Controls {
  readonly keys = new KeyState();
  /** Q and E casts. */
  readonly cast = new CastLatch();
  /** Called for 1–4 in debug mode (?debug=1). */
  onDebugHero: ((hero: HeroId) => void) | null = null;
  /** Called once per Esc press (stage 1b.3). */
  onPause: (() => void) | null = null;
  /** Mouse position in normalised device coordinates (−1..1). */
  readonly ndc = { x: 0, y: 0 };
  attackHeld = false;
  private readonly off: (() => void)[] = [];

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly debug = false,
  ) {
    const on = <K extends keyof WindowEventMap>(
      target: Window | HTMLElement | Document,
      type: K | string,
      fn: (e: never) => void,
    ): void => {
      target.addEventListener(type, fn as EventListener);
      this.off.push(() => target.removeEventListener(type, fn as EventListener));
    };

    on(window, 'keydown', (e: KeyboardEvent) => {
      if (isGameKey(e.code)) e.preventDefault();
      this.keys.down(e.code);
      this.cast.keyDown(e.code, e.repeat);
      const hero = e.repeat ? null : debugHeroKey(e.code, this.debug);
      if (hero) this.onDebugHero?.(hero);
      if (isPauseKey(e.code, e.repeat)) this.onPause?.();
    });
    on(window, 'keyup', (e: KeyboardEvent) => {
      this.keys.up(e.code);
      this.cast.keyUp(e.code);
    });
    on(window, 'blur', () => this.releaseAll());
    on(document, 'visibilitychange', () => {
      if (document.hidden) this.releaseAll();
    });
    on(canvas, 'pointermove', (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      this.ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1;
      this.ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1;
    });
    on(canvas, 'pointerdown', (e: PointerEvent) => {
      if (e.button !== 0) return;
      canvas.focus();
      this.attackHeld = true;
    });
    on(window, 'pointerup', (e: PointerEvent) => {
      if (e.button === 0) this.attackHeld = false;
    });
    on(canvas, 'contextmenu', (e: MouseEvent) => e.preventDefault());
  }

  get reviveHeld(): boolean {
    return this.keys.isDown('KeyF');
  }

  releaseAll(): void {
    this.keys.clear();
    this.cast.cancel();
    this.attackHeld = false;
  }

  dispose(): void {
    for (const f of this.off) f();
    this.off.length = 0;
    this.canvas.blur();
  }
}
