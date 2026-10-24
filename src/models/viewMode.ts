import type { ParamField } from "./types";

/**
 * Parameters that describe the device model (SPICE-style coefficients, coupling, thresholds …) rather than
 * the part's everyday value. Simple view hides them; Advanced view shows everything. The defining characteristic of
 * each part (BJT beta, MOSFET threshold, op-amp gain, optocoupler CTR …) stays visible in both views.
 */
const ADVANCED_KEYS = new Set([
  "tolerance",
  "dcr",
  "primaryInductance",
  "coupling",
  "primaryResistance",
  "coreLoss",
  "vf",
  "kp",
  "vp",
  "igt",
  "holding",
  "vdrm",
  "headroom",
  "dropout",
  "rout",
  "rint",
  "r10lux",
  "gamma",
  "r25",
  "alpha",
  "coilResistance",
  "maxIc",
  "maxId",
  "maxPower",
  // oscilloscope fine controls (the instrument dock has them)
  "pos1",
  "pos2",
  "cpl1",
  "cpl2",
  "trigEdge",
  "trigMode",
  "autoLevel",
  "trigger",
  "math",
  "display",
  "trigSrc",
  "vdiv1",
  "vdiv2",
]);

export const isAdvancedField = (f: ParamField): boolean => ADVANCED_KEYS.has(f.key);
