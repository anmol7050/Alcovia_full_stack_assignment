import AsyncStorage from '@react-native-async-storage/async-storage';
import { AppState, DEFAULT_STATE } from '../store/types';

// Each device gets its own storage namespace via deviceId prefix
// On web, two browser tabs share AsyncStorage; we use a namespace key
// passed in at startup (from URL param or generated).

let NAMESPACE = 'default';

export function setStorageNamespace(ns: string) {
  NAMESPACE = ns;
}

function key(k: string): string {
  return `alcovia:${NAMESPACE}:${k}`;
}

export async function loadState(): Promise<AppState | null> {
  try {
    const raw = await AsyncStorage.getItem(key('appstate'));
    if (!raw) return null;
    return JSON.parse(raw) as AppState;
  } catch {
    return null;
  }
}

export async function saveState(state: AppState): Promise<void> {
  try {
    await AsyncStorage.setItem(key('appstate'), JSON.stringify(state));
  } catch (e) {
    console.error('[Storage] Failed to save state', e);
  }
}

export async function clearState(): Promise<void> {
  await AsyncStorage.removeItem(key('appstate'));
}
