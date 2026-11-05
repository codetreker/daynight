import { useSyncExternalStore } from 'react';
import { createSessionDisplayPreferenceStore, type SessionDisplayBinding, type SessionDisplayPreferenceStore } from './display-preference';

const pagePreferences = createSessionDisplayPreferenceStore();

/** Selects identity during render, so a new account/Session never renders the old preference. */
export function useSessionDisplayPreference(binding: SessionDisplayBinding, preferences: SessionDisplayPreferenceStore = pagePreferences) {
  const preference = preferences.get(binding);
  const snapshot = useSyncExternalStore(preference.subscribe, preference.getSnapshot);
  return { ...snapshot, setMode: preference.setMode, retrySave: preference.retrySave };
}

/** Forget a deleted or inaccessible Session's display state, including storage failures. */
export function clearSessionDisplayPreference(binding: SessionDisplayBinding): void { pagePreferences.remove(binding); }
