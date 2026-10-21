import { sim } from "./runtime";
import type { ProbeStore } from "./devices";

/** Accessor for the scope / logic analyser sample buffers kept by the simulator. */
export const probes = (): ProbeStore => sim.probes;
