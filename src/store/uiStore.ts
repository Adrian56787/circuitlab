import { create } from "zustand";
import type { CategoryId, WireColor, WireRouting } from "@/models/types";

export type Tool = "select" | "wire" | "pan";

interface UiState {
  tool: Tool;
  /** Component kind armed for click-to-place (set from the sidebar). */
  placingKind: string | null;
  search: string;
  openCategories: Record<CategoryId, boolean>;
  wireColor: WireColor;
  wireCustomColor: string;
  wireRouting: WireRouting;
  inspectorOpen: boolean;
  scopeOpen: boolean;
  dockTab: "instruments" | "code" | "serial";
  dockHeight: number;
  mcuId: string | null;
  colorCalcOpen: boolean;
  toast: { id: number; text: string; tone: "info" | "warn" | "error" } | null;

  setTool: (t: Tool) => void;
  setPlacing: (kind: string | null) => void;
  setSearch: (q: string) => void;
  toggleCategory: (id: CategoryId) => void;
  setWireColor: (c: WireColor, custom?: string) => void;
  setWireRouting: (r: WireRouting) => void;
  setInspectorOpen: (v: boolean) => void;
  setScopeOpen: (v: boolean) => void;
  setDockTab: (t: "instruments" | "code" | "serial") => void;
  setDockHeight: (h: number) => void;
  /** Open the dock on the code editor for a microcontroller. */
  openCode: (id: string) => void;
  setColorCalcOpen: (v: boolean) => void;
  notify: (text: string, tone?: "info" | "warn" | "error") => void;
}

let toastId = 0;

export const useUiStore = create<UiState>((set) => ({
  tool: "select",
  placingKind: null,
  search: "",
  openCategories: {
    passive: true,
    semiconductor: true,
    ic: false,
    power: true,
    input: false,
    output: false,
    instrument: false,
  },
  wireColor: "auto",
  wireCustomColor: "#39ff88",
  wireRouting: "orthogonal",
  inspectorOpen: true,
  scopeOpen: false,
  dockTab: "instruments",
  dockHeight: 340,
  mcuId: null,
  colorCalcOpen: false,
  toast: null,

  setTool: (tool) => set({ tool, placingKind: null }),
  setPlacing: (placingKind) => set({ placingKind, tool: "select" }),
  setSearch: (search) => set({ search }),
  toggleCategory: (id) => set((s) => ({ openCategories: { ...s.openCategories, [id]: !s.openCategories[id] } })),
  setWireColor: (wireColor, custom) => set((s) => ({ wireColor, wireCustomColor: custom ?? s.wireCustomColor })),
  setWireRouting: (wireRouting) => set({ wireRouting }),
  setInspectorOpen: (inspectorOpen) => set({ inspectorOpen }),
  setScopeOpen: (scopeOpen) => set({ scopeOpen }),
  setDockTab: (dockTab) => set({ dockTab }),
  setDockHeight: (h) => set({ dockHeight: Math.round(Math.min(640, Math.max(140, h))) }),
  openCode: (mcuId) => set({ mcuId, dockTab: "code", scopeOpen: true }),
  setColorCalcOpen: (colorCalcOpen) => set({ colorCalcOpen }),
  notify: (text, tone = "info") => set({ toast: { id: ++toastId, text, tone } }),
}));
