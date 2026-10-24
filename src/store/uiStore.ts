import { create } from "zustand";
import type { CategoryId, Rotation, WireColor, WireRouting } from "@/models/types";

export type Tool = "select" | "wire" | "pan";

interface UiState {
  tool: Tool;
  /** Component kind armed for click-to-place (set from the sidebar). */
  placingKind: string | null;
  /** Orientation of the part being placed (applied to the ghost and to the placed component). */
  placeRotation: Rotation;
  placeMirror: boolean;
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
  settingsOpen: boolean;
  failuresOpen: boolean;
  /** Hover-dwell help card over a canvas part (screen position inside the canvas host). */
  helpHover: { kind: string; x: number; y: number } | null;
  toast: { id: number; text: string; tone: "info" | "warn" | "error"; ms: number } | null;

  setTool: (t: Tool) => void;
  setPlacing: (kind: string | null) => void;
  /** Rotate the part being placed by 90° (counter-clockwise when `ccw`). */
  rotatePlacing: (ccw?: boolean) => void;
  flipPlacing: () => void;
  setSettingsOpen: (v: boolean) => void;
  setFailuresOpen: (v: boolean) => void;
  setHelpHover: (h: { kind: string; x: number; y: number } | null) => void;
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
  notify: (text: string, tone?: "info" | "warn" | "error", ms?: number) => void;
}

let toastId = 0;

export const useUiStore = create<UiState>((set) => ({
  tool: "select",
  placingKind: null,
  placeRotation: 0,
  placeMirror: false,
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
  settingsOpen: false,
  failuresOpen: false,
  helpHover: null,
  toast: null,

  setTool: (tool) => set({ tool, placingKind: null }),
  // arming a different part starts from its default orientation; re-arming the same one keeps it
  setPlacing: (placingKind) =>
    set((s) => (placingKind !== s.placingKind ? { placingKind, tool: "select", placeRotation: 0, placeMirror: false } : { placingKind, tool: "select" })),
  rotatePlacing: (ccw = false) =>
    set((s) => ({ placeRotation: ((s.placeRotation + (ccw ? 270 : 90)) % 360) as Rotation })),
  flipPlacing: () => set((s) => ({ placeMirror: !s.placeMirror })),
  setSettingsOpen: (settingsOpen) => set({ settingsOpen }),
  setFailuresOpen: (failuresOpen) => set({ failuresOpen }),
  setHelpHover: (helpHover) => set({ helpHover }),
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
  notify: (text, tone = "info", ms = 4500) => set({ toast: { id: ++toastId, text, tone, ms } }),
}));
