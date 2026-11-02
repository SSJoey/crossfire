export interface ViewHooks<V> {
  /** Upper bound on views ever created. */
  max: number;
  onShow(v: V): void;
  onHide(v: V): void;
  onDie?(v: V): void;
}

interface Dying<V> {
  view: V;
  left: number;
}

/**
 * Pooled views for synced entities (enemies, bolts), keyed by entity id.
 * A killed entity's view stays visible while it plays its death, then returns to the pool.
 * If the pool is exhausted, the oldest dying view is recycled early.
 */
export class ViewRegistry<V> {
  private readonly active = new Map<string, V>();
  private readonly dying: Dying<V>[] = [];
  private readonly dyingFree: Dying<V>[] = [];
  private readonly free: V[] = [];
  private created = 0;

  constructor(
    private readonly create: () => V,
    private readonly hooks: ViewHooks<V>,
  ) {}

  get activeCount(): number {
    return this.active.size;
  }

  get dyingCount(): number {
    return this.dying.length;
  }

  get(id: string): V | undefined {
    return this.active.get(id);
  }

  /** The view for `id`, taking one from the pool if needed. Null when the pool is exhausted. */
  acquire(id: string): V | null {
    const cur = this.active.get(id);
    if (cur) return cur;
    let v = this.free.pop();
    if (!v) {
      if (this.created < this.hooks.max) {
        v = this.create();
        this.created++;
      } else if (this.dying.length > 0) {
        const d = this.dying.shift()!;
        v = d.view;
        this.hooks.onHide(v);
        this.dyingFree.push(d);
      } else {
        return null;
      }
    }
    this.active.set(id, v);
    this.hooks.onShow(v);
    return v;
  }

  /** The entity died: keep its view for `seconds` to play the death. */
  kill(id: string, seconds: number): void {
    const v = this.active.get(id);
    if (!v) return;
    this.active.delete(id);
    const d = this.dyingFree.pop() ?? { view: v, left: 0 };
    d.view = v;
    d.left = seconds;
    this.dying.push(d);
    this.hooks.onDie?.(v);
  }

  /** The entity is gone without a death (back to the lobby): hide at once. */
  release(id: string): void {
    const v = this.active.get(id);
    if (!v) return;
    this.active.delete(id);
    this.hooks.onHide(v);
    this.free.push(v);
  }

  releaseAll(): void {
    for (const id of [...this.active.keys()]) this.release(id);
    while (this.dying.length > 0) {
      const d = this.dying.pop()!;
      this.hooks.onHide(d.view);
      this.free.push(d.view);
      this.dyingFree.push(d);
    }
  }

  update(dt: number): void {
    let w = 0;
    for (let r = 0; r < this.dying.length; r++) {
      const d = this.dying[r]!;
      d.left -= dt;
      if (d.left <= 0) {
        this.hooks.onHide(d.view);
        this.free.push(d.view);
        this.dyingFree.push(d);
      } else {
        this.dying[w++] = d;
      }
    }
    this.dying.length = w;
  }

  forEachActive(cb: (v: V, id: string) => void): void {
    this.active.forEach(cb);
  }

  forEachDying(cb: (v: V, secondsLeft: number) => void): void {
    for (const d of this.dying) cb(d.view, d.left);
  }
}
