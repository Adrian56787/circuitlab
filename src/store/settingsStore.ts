import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import { FEATURE_GROUPS } from "@/models/featureGroups";

export type ViewMode = "simple" | "advanced";

interface SettingsState {
  /** group id → true when the group is hidden from the component library */
  disabledGroups: Record<string, boolean>;
  /** Simple hides model / SPICE-style parameters in the Inspector. */
  viewMode: ViewMode;
  /** Show the explanatory help card when hovering a part. */
  hoverHelp: boolean;
  /** true once the persisted values were read from localStorage (client only). */
  hydrated: boolean;

  setGroupEnabled: (id: string, enabled: boolean) => void;
  setAllGroups: (enabled: boolean, except?: string[]) => void;
  setViewMode: (m: ViewMode) => void;
  setHoverHelp: (v: boolean) => void;
  reset: () => void;
}

const ALL_GROUP_IDS = FEATURE_GROUPS.map((g) => g.id);

/** localStorage can throw (private windows, blocked site data): fall back to a no-op store. */
const safeStorage: StateStorage = {
  getItem: (k) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  setItem: (k, v) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* ignore */
    }
  },
  removeItem: (k) => {
    try {
      localStorage.removeItem(k);
    } catch {
      /* ignore */
    }
  },
};

const DEFAULTS = { disabledGroups: {} as Record<string, boolean>, viewMode: "advanced" as ViewMode, hoverHelp: true };

/**
 * Persisted preferences. Hydration is manual (`persist.rehydrate()` from the page) so the server-rendered markup
 * and the first client render agree.
 */
export const useSettingsStore = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      hydrated: false,
      setGroupEnabled: (id, enabled) =>
        set((s) => {
          const next = { ...s.disabledGroups };
          if (enabled) delete next[id];
          else next[id] = true;
          return { disabledGroups: next };
        }),
      setAllGroups: (enabled, except = []) =>
        set({ disabledGroups: enabled ? {} : Object.fromEntries(ALL_GROUP_IDS.filter((g) => !except.includes(g)).map((g) => [g, true])) }),
      setViewMode: (viewMode) => set({ viewMode }),
      setHoverHelp: (hoverHelp) => set({ hoverHelp }),
      reset: () => set({ ...DEFAULTS, disabledGroups: {} }),
    }),
    {
      name: "circuitlab-settings",
      version: 1,
      storage: createJSONStorage(() => safeStorage),
      skipHydration: true,
      partialize: (s) => ({ disabledGroups: s.disabledGroups, viewMode: s.viewMode, hoverHelp: s.hoverHelp }),
      onRehydrateStorage: () => () => {
        useSettingsStore.setState({ hydrated: true });
      },
    },
  ),
);
