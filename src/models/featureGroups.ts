import type { ComponentDef } from "./types";

/**
 * Library feature flags. Every catalog part belongs to exactly one group (first match wins); a group can be switched
 * off in Settings to hide all of its parts from the component library. Parts already on the canvas are unaffected.
 */
export interface FeatureGroup {
  id: string;
  label: string;
  description: string;
  match: (d: ComponentDef) => boolean;
}

const kinds =
  (...k: string[]) =>
  (d: ComponentDef): boolean =>
    k.includes(d.kind);

export const FEATURE_GROUPS: FeatureGroup[] = [
  { id: "core", label: "Ground", description: "The 0 V reference. Always available.", match: kinds("ground") },
  { id: "ac", label: "AC sources & generators", description: "AC voltage source and function generator.", match: kinds("vac", "sigen") },
  { id: "dc", label: "DC sources & batteries", description: "Bench supply and batteries.", match: (d) => d.category === "power" },
  { id: "magnetics", label: "Inductors & transformers", description: "Coils and (centre-tap) transformers.", match: kinds("inductor", "transformer", "transformer_ct") },
  { id: "passive", label: "Resistors, capacitors & pots", description: "Basic passive components.", match: (d) => d.category === "passive" },
  { id: "semiconductor", label: "Semiconductors", description: "Diodes, LEDs, transistors, thyristors, optocouplers.", match: (d) => d.category === "semiconductor" },
  { id: "logic", label: "Logic gates", description: "AND, OR, NOT, NAND, NOR and XOR gates.", match: (d) => d.sim === "gate" },
  { id: "mcu", label: "Microcontrollers & LCD", description: "Arduino Uno, ESP32, ATtiny85 and the 16×2 LCD.", match: (d) => d.sim === "mcu" || d.sim === "lcd" },
  { id: "analog-ic", label: "Analog ICs", description: "555 timer, op-amps and voltage regulators.", match: (d) => d.category === "ic" },
  { id: "input", label: "Switches & sensors", description: "Buttons, switches, LDR, thermistors, ultrasonic sensor.", match: (d) => d.category === "input" },
  { id: "output", label: "Outputs & indicators", description: "RGB LED, displays, buzzer, motors, servo, relay.", match: (d) => d.category === "output" },
  { id: "instrument", label: "Instruments", description: "Multimeter, oscilloscope and logic analyser.", match: (d) => d.category === "instrument" },
];

const cache = new Map<string, string>();

/** Group id a part belongs to. */
export function groupOf(def: ComponentDef): string {
  const hit = cache.get(def.kind);
  if (hit) return hit;
  const g = FEATURE_GROUPS.find((x) => x.match(def))?.id ?? "core";
  cache.set(def.kind, g);
  return g;
}

/** Groups that cannot be switched off. */
export const LOCKED_GROUPS = new Set(["core"]);
