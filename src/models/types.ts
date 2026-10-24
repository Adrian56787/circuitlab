/**
 * Core domain types for the circuit editor and simulator.
 * Coordinates for components and pins are expressed in GRID UNITS (integers).
 * The renderer multiplies by GRID_PX to get world pixels.
 */

export const GRID_PX = 20;

export interface Vec2 {
  x: number;
  y: number;
}

export type Rotation = 0 | 90 | 180 | 270;

// ───────────────────────── Catalog ─────────────────────────

export type CategoryId =
  | "passive"
  | "semiconductor"
  | "ic"
  | "power"
  | "input"
  | "output"
  | "instrument";

export interface CategoryInfo {
  id: CategoryId;
  label: string;
  accent: string;
}

export type PinKind =
  | "passive"
  | "power"
  | "ground"
  | "input"
  | "output"
  | "io"
  | "analog";

export interface PinDef {
  id: string;
  label: string;
  /** Position relative to the component origin, grid units, before rotation. */
  x: number;
  y: number;
  kind: PinKind;
}

export type ParamValue = number | string | boolean;
export type Params = Record<string, ParamValue>;

export type UnitFamily =
  | "ohm"
  | "farad"
  | "henry"
  | "volt"
  | "amp"
  | "hertz"
  | "watt"
  | "second"
  | "none";

export type ParamField =
  | {
      key: string;
      label: string;
      type: "number";
      unit: UnitFamily;
      min?: number;
      max?: number;
      step?: number;
      help?: string;
    }
  | {
      key: string;
      label: string;
      type: "select";
      options: { value: string; label: string }[];
      help?: string;
    }
  | { key: string; label: string; type: "boolean"; help?: string }
  | { key: string; label: string; type: "slider"; min: number; max: number; step: number; help?: string }
  | { key: string; label: string; type: "text"; help?: string };

/** Which numerical model the simulator uses for this part. */
export type SimModel =
  | "none"
  | "ground"
  | "resistor"
  | "capacitor"
  | "inductor"
  | "vsource"
  | "diode"
  | "bjt"
  | "mosfet"
  | "switch"
  | "potentiometer"
  | "load"
  | "relay"
  | "diodeArray"
  | "opamp"
  | "gate"
  | "timer555"
  | "regulator"
  | "mcu"
  | "meter"
  | "jfet"
  | "scr"
  | "triac"
  | "opto"
  | "transformer"
  | "servo"
  | "ultrasonic"
  | "lcd";

/** How the part looks in physical (photoreal-vector) view. */
export type PackageStyle =
  | "axial"
  | "radial"
  | "ceramic"
  | "electrolytic"
  | "tantalum"
  | "to92"
  | "to220"
  | "diode"
  | "led"
  | "dip"
  | "module"
  | "battery"
  | "switch"
  | "pot"
  | "coil"
  | "transformer"
  | "generic";

export interface ComponentDef {
  kind: string;
  name: string;
  category: CategoryId;
  description: string;
  /** Bounding box [x0, y0, x1, y1] in grid units, before rotation. */
  bounds: [number, number, number, number];
  /** Optional body rectangle for IC / module style symbols (grid units). */
  body?: [number, number, number, number];
  /** Also listed under these categories in the sidebar. */
  alsoIn?: CategoryId[];
  pins: PinDef[];
  defaults: Params;
  fields: ParamField[];
  symbol: string;
  pkg: PackageStyle;
  sim: SimModel;
  tags: string[];
  /** Designator prefix: R, C, U, Q ... */
  prefix: string;
}

// ───────────────────────── Circuit ─────────────────────────

export interface PlacedComponent {
  id: string;
  kind: string;
  x: number;
  y: number;
  rotation: Rotation;
  mirror: boolean;
  params: Params;
  label: string;
}

export interface PinRef {
  componentId: string;
  pinId: string;
}

export type WireColor = "auto" | "vcc" | "gnd" | "signal" | "custom";
export type WireRouting = "orthogonal" | "bezier";

export interface Wire {
  id: string;
  from: PinRef;
  to: PinRef;
  color: WireColor;
  custom?: string;
  routing: WireRouting;
}

export interface CircuitData {
  version: 1;
  name: string;
  components: PlacedComponent[];
  wires: Wire[];
}

// ───────────────────────── Simulation ─────────────────────────

export type LogicLevel = "high" | "low" | "floating";

export interface ComponentSnapshot {
  /** Current flowing from pin[0] to pin[1] through the part (A). */
  current: number;
  /** Voltage across the part, pin[0] minus pin[1] (V). */
  voltage: number;
  power: number;
  /** Fraction 0..1+ of the rated limit that is being used. */
  stress: number;
  burned: boolean;
  /** Why the part failed (set once `burned`): the exceeded rating, the numbers and a remedy. */
  failure?: string;
  /** Free-form per-part display state (LED brightness, switch state ...). */
  aux: Record<string, number>;
}

export interface SimDiagnostics {
  messages: string[];
  autoGround: boolean;
  singular: boolean;
  converged: boolean;
  iterations: number;
}

/** A destroyed part and the reason, in the order the failures happened. */
export interface FailureRecord {
  id: string;
  label: string;
  name: string;
  /** simulation time of the failure (s) */
  time: number;
  reason: string;
}

export interface SimSnapshot {
  time: number;
  /** netId → volts */
  netVoltage: Record<string, number>;
  /** "compId:pinId" → netId */
  pinNet: Record<string, string>;
  components: Record<string, ComponentSnapshot>;
  /** wire id → current from wire.from to wire.to (A) */
  wireCurrent: Record<string, number>;
  /** netId → logic level, only for nets that carry digital signals. */
  logic: Record<string, LogicLevel>;
  /** wire id → netId */
  wireNet: Record<string, string>;
  /** Ids of parts destroyed so far. */
  burned: string[];
  /** Failure log with explanations. */
  failures: FailureRecord[];
  diagnostics: SimDiagnostics;
}

export const pinKey = (r: PinRef): string => `${r.componentId}:${r.pinId}`;
