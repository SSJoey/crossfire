/**
 * A small read-only view of the client state on window.__crossfire, used by the Playwright
 * tests. It holds no secrets and controls nothing.
 */
export interface DebugView {
  phase: string;
  me: { x: number; z: number; status: string; hero: string; eCd: number } | null;
  /** Zones on the ground. */
  zones: number;
  /** The Q preview is showing. */
  qPreview: boolean;
  /** The run is paused (stage 1b.3). */
  paused: boolean;
}

const view: DebugView = { phase: 'none', me: null, zones: 0, qPreview: false, paused: false };
(window as unknown as { __crossfire: DebugView }).__crossfire = view;

export function debugView(): DebugView {
  return view;
}
