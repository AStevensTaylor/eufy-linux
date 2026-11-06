import { useSyncExternalStore } from "react";
import type { Observable } from "./observable";

export function useObservable<T>(obs: Observable<T>): T {
  return useSyncExternalStore(obs.subscribe, obs.get, obs.get);
}
