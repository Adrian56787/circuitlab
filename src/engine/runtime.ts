import type { SimSnapshot } from "@/models/types";
import { useUiStore } from "@/store/uiStore";
import { Simulator } from "./simulator";

/** Module-level singletons shared by the canvas renderer and the panels. */
export const sim = new Simulator();

let live: SimSnapshot | null = null;
export const getLive = (): SimSnapshot | null => live;
export const setLive = (s: SimSnapshot | null): void => {
  live = s;
};

/** Burn animation bookkeeping: component id → performance.now() when it blew. */
export const burnTimes = new Map<string, number>();
sim.onBurn = (c, reason) => {
  if (!burnTimes.has(c.id)) burnTimes.set(c.id, performance.now());
  useUiStore.getState().notify(`${c.label} burnt out. ${reason}`, "error", 12000);
};
