import { create } from "zustand";

interface SimState {
  running: boolean;
  /** Circuit seconds simulated per real second. */
  speed: number;
  /** Maximum solver step (s); the runner shrinks it automatically for AC sources. */
  baseDt: number;
  /** Increments ~10×/s so React panels can re-read the live snapshot. */
  tick: number;
  /** Pending single-step requests. */
  stepRequests: number;
  resetRequests: number;

  play: () => void;
  pause: () => void;
  toggle: () => void;
  step: () => void;
  reset: () => void;
  setSpeed: (s: number) => void;
  bump: () => void;
}

export const useSimStore = create<SimState>((set) => ({
  running: false,
  speed: 1,
  baseDt: 2e-5,
  tick: 0,
  stepRequests: 0,
  resetRequests: 0,

  play: () => set({ running: true }),
  pause: () => set({ running: false }),
  toggle: () => set((s) => ({ running: !s.running })),
  step: () => set((s) => ({ running: false, stepRequests: s.stepRequests + 1 })),
  reset: () => set((s) => ({ running: false, resetRequests: s.resetRequests + 1 })),
  setSpeed: (speed) => set({ speed }),
  bump: () => set((s) => ({ tick: s.tick + 1 })),
}));

/** Slider position (0…1) ↔ speed on a log scale from 1/1000× to 1000×. */
export const speedFromSlider = (t: number): number => 10 ** (-3 + 6 * t);
export const sliderFromSpeed = (s: number): number => (Math.log10(s) + 3) / 6;
