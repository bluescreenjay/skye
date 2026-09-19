/** Prevents overlapping close actions for the same TabRef id (double-click X). */
export function createCloseInFlight() {
  const pending = new Set<string>();
  return {
    begin(id: string): boolean {
      if (pending.has(id)) return false;
      pending.add(id);
      return true;
    },
    end(id: string): void {
      pending.delete(id);
    },
    has(id: string): boolean {
      return pending.has(id);
    },
  };
}
