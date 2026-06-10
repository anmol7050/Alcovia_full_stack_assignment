import { useEffect, useState, useRef } from 'react';
import { getStore } from './store';
import { AppState } from './types';

export function useAppStore() {
  const store = getStore();
  const [state, setState] = useState<AppState>(store.getState());

  useEffect(() => {
    const unsub = store.subscribe(setState);
    return unsub;
  }, []);

  return { state, store };
}
