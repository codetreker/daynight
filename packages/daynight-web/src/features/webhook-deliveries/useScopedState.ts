import { useRef, useState, type Dispatch, type SetStateAction } from "react";

export const useScopedState = <T,>(key: string, initial: T): readonly [T, Dispatch<SetStateAction<T>>] => {
  const [states, setStates] = useState<ReadonlyMap<string, T>>(new Map());
  const current = useRef(key); current.current = key;
  return [states.get(key) ?? initial, update => {
    const scope = current.current;
    setStates(old => {
      const next = new Map(old), previous = old.get(scope) ?? initial;
      next.set(scope, typeof update === "function" ? (update as (previous: T) => T)(previous) : update);
      return next;
    });
  }];
};
