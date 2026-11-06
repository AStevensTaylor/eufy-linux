/** Minimal observable value, compatible with React's `useSyncExternalStore`. */
export type Observable<T> = {
  get(): T;
  set(value: T): void;
  subscribe(listener: (value: T) => void): () => void;
};

export function createObservable<T>(initial: T): Observable<T> {
  let value = initial;
  const listeners = new Set<(value: T) => void>();
  return {
    get: () => value,
    set(next) {
      if (Object.is(next, value)) return;
      value = next;
      for (const l of Array.from(listeners)) l(value);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
