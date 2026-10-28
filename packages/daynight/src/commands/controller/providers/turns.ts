export class NativeTurns {
  private readonly completed = new Map<string, Error | null>();
  private readonly waiters = new Map<string, Set<(error: Error | null) => void>>();
  isComplete(id: string): boolean { return this.completed.has(id); }
  complete(id: string, error: Error | null): void { this.completed.set(id, error); for (const resolve of this.waiters.get(id) ?? []) resolve(error); this.waiters.delete(id); }
  wait(id: string, deadline: number): Promise<void> {
    if (this.completed.has(id)) { const error = this.completed.get(id); return error ? Promise.reject(error) : Promise.resolve(); }
    return new Promise((resolve, reject) => {
      const finish = (error: Error | null) => { clearTimeout(timer); this.waiters.get(id)?.delete(finish); error ? reject(error) : resolve(); };
      const timer = setTimeout(() => finish(new Error("Native turn completion is unknown after its deadline.")), Math.max(0, deadline - Date.now()));
      const waiters = this.waiters.get(id) ?? new Set(); waiters.add(finish); this.waiters.set(id, waiters);
    });
  }
}
