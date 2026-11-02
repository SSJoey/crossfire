/**
 * A small read-only view of the client state on window.__crossfire, used by the Playwright
 * smoke test. It holds no secrets and controls nothing.
 */
export interface DebugView {
  phase: string;
  me: { x: number; z: number; status: string } | null;
}

const view: DebugView = { phase: 'none', me: null };
(window as unknown as { __crossfire: DebugView }).__crossfire = view;

export function debugView(): DebugView {
  return view;
}
