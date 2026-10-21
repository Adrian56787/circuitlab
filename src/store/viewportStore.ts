import { create } from "zustand";

export type GridMode = "dots" | "lines" | "none";
export type ViewStyle = "schematic" | "physical";

interface ViewportState {
  panX: number;
  panY: number;
  zoom: number;
  gridMode: GridMode;
  snapToGrid: boolean;
  viewStyle: ViewStyle;
  showCurrent: boolean;
  showVoltages: boolean;

  setPan: (x: number, y: number) => void;
  panBy: (dx: number, dy: number) => void;
  /** Zoom around a screen-space anchor so the point under the cursor stays fixed. */
  zoomAt: (factor: number, sx: number, sy: number) => void;
  setZoom: (zoom: number) => void;
  resetView: () => void;
  setGridMode: (m: GridMode) => void;
  toggleSnap: () => void;
  setViewStyle: (v: ViewStyle) => void;
  toggleCurrent: () => void;
  toggleVoltages: () => void;
}

export const MIN_ZOOM = 0.15;
export const MAX_ZOOM = 5;

export const useViewportStore = create<ViewportState>((set) => ({
  panX: 80,
  panY: 80,
  zoom: 1,
  gridMode: "dots",
  snapToGrid: true,
  viewStyle: "schematic",
  showCurrent: true,
  showVoltages: true,

  setPan: (panX, panY) => set({ panX, panY }),
  panBy: (dx, dy) => set((s) => ({ panX: s.panX + dx, panY: s.panY + dy })),
  zoomAt: (factor, sx, sy) =>
    set((s) => {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, s.zoom * factor));
      const k = zoom / s.zoom;
      return { zoom, panX: sx - (sx - s.panX) * k, panY: sy - (sy - s.panY) * k };
    }),
  setZoom: (zoom) => set({ zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, zoom)) }),
  resetView: () => set({ panX: 80, panY: 80, zoom: 1 }),
  setGridMode: (gridMode) => set({ gridMode }),
  toggleSnap: () => set((s) => ({ snapToGrid: !s.snapToGrid })),
  setViewStyle: (viewStyle) => set({ viewStyle }),
  toggleCurrent: () => set((s) => ({ showCurrent: !s.showCurrent })),
  toggleVoltages: () => set((s) => ({ showVoltages: !s.showVoltages })),
}));
