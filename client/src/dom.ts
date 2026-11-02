type Child = Node | string | null | undefined | false;

export interface ElOptions {
  id?: string;
  className?: string;
  /** Always set with textContent: names and user text are never parsed as HTML. */
  text?: string;
  attrs?: Record<string, string>;
}

/** Creates an element. Strings among the children become text nodes, never HTML. */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  opts: ElOptions = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (opts.id) e.id = opts.id;
  if (opts.className) e.className = opts.className;
  if (opts.text !== undefined) e.textContent = opts.text;
  if (opts.attrs) for (const [k, v] of Object.entries(opts.attrs)) e.setAttribute(k, v);
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    e.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return e;
}

/** Sets text only when it changed (cheap to call every frame). */
export function setText(e: HTMLElement, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

export function show(e: HTMLElement, on: boolean): void {
  if (e.hidden === on) e.hidden = !on;
}

export function formatTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}
