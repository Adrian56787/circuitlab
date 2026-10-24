import { LED_VF } from "@/models/catalog";
import type { ComponentDef, ComponentSnapshot, Params, PlacedComponent, UnitFamily } from "@/models/types";
import { formatEng } from "@/models/units";
import type { Stamper } from "./mna";

// ───────────────────────── shared types ─────────────────────────

export interface StepCtx {
  /** Simulation time at the END of the step being solved. */
  t: number;
  dt: number;
  /** DC operating point: capacitors open, inductors shorted, dt = 0. */
  dc: boolean;
  /** Source ramp used for source-stepping convergence aid (0…1). */
  srcScale: number;
  /** Continuation parameter (0…1] used by stiff behavioural blocks when Newton fails. */
  homotopy: number;
}

export class DeviceState {
  burned = false;
  /** 0…1; reaching 1 destroys the part. */
  heat = 0;
  /** Human-readable explanation of why the part failed (filled in at the moment it burns). */
  cause = "";
  n: Record<string, number> = {};
  f: Record<string, boolean> = {};
  /** Arbitrary persistent object (e.g. a microcontroller's running program). */
  obj: unknown = null;
}

export class ProbeBuffer {
  readonly t: Float64Array;
  readonly ch: Float32Array[];
  /** per-sample minimum / maximum seen since the previous stored sample (peak-detect envelope) */
  readonly lo: Float32Array[];
  readonly hi: Float32Array[];
  head = 0;
  count = 0;
  lastT = -Infinity;
  /** scope bookkeeping: last trigger time and a memo of the last computed sweep */
  lastTrig = -Infinity;
  memo: { key: string; value: unknown } | null = null;
  constructor(
    readonly channels: number,
    readonly capacity = 6000,
  ) {
    this.t = new Float64Array(capacity);
    this.ch = Array.from({ length: channels }, () => new Float32Array(capacity));
    this.lo = Array.from({ length: channels }, () => new Float32Array(capacity));
    this.hi = Array.from({ length: channels }, () => new Float32Array(capacity));
  }
  push(t: number, values: number[], lo?: number[], hi?: number[]): void {
    this.t[this.head] = t;
    for (let i = 0; i < this.channels; i++) {
      const v = values[i] ?? 0;
      this.ch[i]![this.head] = v;
      this.lo[i]![this.head] = lo ? Math.min(lo[i] ?? v, v) : v;
      this.hi[i]![this.head] = hi ? Math.max(hi[i] ?? v, v) : v;
    }
    this.head = (this.head + 1) % this.capacity;
    this.count = Math.min(this.count + 1, this.capacity);
    this.lastT = t;
  }
  clear(): void {
    this.head = 0;
    this.count = 0;
    this.lastT = -Infinity;
    this.lastTrig = -Infinity;
    this.memo = null;
  }
  /** Ring index of the i-th retained sample (0 = oldest). */
  idx(i: number): number {
    return (this.head - this.count + i + this.capacity * 2) % this.capacity;
  }
  /** i = 0 is the oldest retained sample. */
  at(i: number): { t: number; v: (c: number) => number } {
    const idx = this.idx(i);
    return { t: this.t[idx]!, v: (c) => this.ch[c]![idx]! };
  }
  timeAt(i: number): number {
    return this.t[this.idx(i)]!;
  }
  /** Index of the first retained sample with time ≥ t (count when none). */
  lowerBound(t: number): number {
    let a = 0;
    let b = this.count;
    while (a < b) {
      const m = (a + b) >> 1;
      if (this.timeAt(m) < t) a = m + 1;
      else b = m;
    }
    return a;
  }
}

export type ProbeStore = Map<string, ProbeBuffer>;

/** One rated quantity of a part, used to explain a failure ("current reached 45 mA, exceeding the 20 mA rating"). */
export interface Limit {
  /** quantity name, e.g. "current", "power dissipation" */
  what: string;
  actual: number;
  limit: number;
  unit: UnitFamily;
  /** how to avoid the failure */
  hint?: string;
}

const eng = (v: number, u: UnitFamily): string => formatEng(Math.abs(v), u, 3);

export const VT = 0.025852; // thermal voltage at 300 K
export const GMIN = 1e-12;
export const G_OPEN = 1e-12;
const G_CLOSED = 1e3;

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
export const nv = (x: Float64Array, node: number): number => (node < 0 ? 0 : x[node]!);

function expl(x: number): number {
  return x <= 40 ? Math.exp(x) : Math.exp(40) * (1 + x - 40);
}
function dexpl(x: number): number {
  return x <= 40 ? Math.exp(x) : Math.exp(40);
}

export const numParam = (p: Params, key: string, fallback: number): number => {
  const v = p[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
};
export const strParam = (p: Params, key: string, fallback: string): string => {
  const v = p[key];
  return typeof v === "string" ? v : fallback;
};
export const boolParam = (p: Params, key: string): boolean => p[key] === true;

// ───────────────────────── base device ─────────────────────────

export abstract class Device {
  nonlinear = false;
  branches = 0;
  branchBase = 0;
  /** Absolute row of this device's first branch variable (set by the simulator). */
  branchIndexAbs = 0;
  /** Heat gained per second per unit of overload (stress − 1). */
  thermalGain = 3;
  protected readonly p: Params;

  constructor(
    readonly comp: PlacedComponent,
    readonly def: ComponentDef,
    /** Node index per pin, in catalog pin order. −1 is ground. */
    readonly nodes: number[],
    readonly st: DeviceState,
  ) {
    this.p = comp.params;
  }

  protected pinNode(id: string): number {
    const i = this.def.pins.findIndex((q) => q.id === id);
    return i < 0 ? -1 : this.nodes[i]!;
  }

  /**
   * Largest step the solver may take from time `t` so that the device's next scheduled event
   * (a microcontroller wake-up, a pulse edge …) lands exactly on a step boundary.
   */
  maxStep(_t: number): number {
    return Infinity;
  }
  /** Linear / companion stamps, called once per time-step. */
  abstract stamp(s: Stamper, ctx: StepCtx): void;
  /** Nonlinear stamps, called every Newton iteration. Returns true if voltage limiting altered the point. */
  stampNL(_s: Stamper, _x: Float64Array, _ctx: StepCtx): boolean {
    return false;
  }
  /** Current flowing INTO the device through each pin, catalog order. */
  abstract pinCurrents(x: Float64Array, ctx: StepCtx): number[];
  /** Fraction of the maximum rating in use (≥ 1 means overloaded). */
  stress(_x: Float64Array, _ctx: StepCtx): number {
    return 0;
  }
  aux(_x: Float64Array, _ctx: StepCtx): Record<string, number> {
    return {};
  }
  /** Every rated quantity that `stress` is built from (used only to explain a failure). */
  protected limits(_x: Float64Array, _ctx: StepCtx): Limit[] {
    return [];
  }
  /** Explain what destroyed the part: the most exceeded rating, with the numbers and a remedy. */
  diagnose(x: Float64Array, ctx: StepCtx): string {
    const name = this.def.name;
    let worst: Limit | null = null;
    let ratio = 0;
    for (const l of this.limits(x, ctx)) {
      const r = l.limit > 0 ? Math.abs(l.actual) / l.limit : 0;
      if (r > ratio) {
        ratio = r;
        worst = l;
      }
    }
    if (!worst) {
      const s = this.stress(x, ctx);
      return `${name} failed: it was driven to ${(s * 100).toFixed(0)} % of its rated limit for too long.`;
    }
    return (
      `${name} failed: ${worst.what} reached ${eng(worst.actual, worst.unit)}, exceeding the ${eng(worst.limit, worst.unit)} maximum rating` +
      ` (${ratio >= 10 ? `≈ ${ratio.toFixed(0)}× the limit` : `${(ratio * 100).toFixed(0)} % of the limit`}).${worst.hint ? " " + worst.hint : ""}`
    );
  }
  /** Commit state after a converged step. */
  accept(x: Float64Array, ctx: StepCtx, _probes: ProbeStore): void {
    if (this.thermalGain > 0 && !ctx.dc) {
      const s = this.stress(x, ctx);
      if (s > 1) this.st.heat = Math.min(1.2, this.st.heat + (s - 1) * this.thermalGain * ctx.dt);
      else this.st.heat = Math.max(0, this.st.heat - 0.4 * ctx.dt);
      if (this.st.heat >= 1 && !this.st.burned) {
        // describe the failure while the overloaded operating point is still in `x`
        this.st.cause = this.diagnose(x, ctx);
        this.st.burned = true;
      }
    }
  }

  report(x: Float64Array, ctx: StepCtx): ComponentSnapshot {
    const cur = this.pinCurrents(x, ctx);
    let power = 0;
    for (let i = 0; i < this.nodes.length; i++) power += nv(x, this.nodes[i]!) * (cur[i] ?? 0);
    const v0 = nv(x, this.nodes[0] ?? -1);
    const v1 = nv(x, this.nodes[1] ?? -1);
    return {
      current: cur[0] ?? 0,
      voltage: v0 - v1,
      power,
      stress: this.stress(x, ctx),
      burned: this.st.burned,
      ...(this.st.burned && this.st.cause ? { failure: this.st.cause } : {}),
      aux: { heat: this.st.heat, ...this.aux(x, ctx) },
    };
  }
}

// ───────────────────────── passive devices ─────────────────────────

/** Two-terminal linear resistance. Covers resistors, LDR, thermistors, buzzers and motors. */
export class ResistorDevice extends Device {
  private readonly r: number;
  private readonly a: number;
  private readonly b: number;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.r = Math.max(1e-6, resistanceOf(comp));
    this.a = nodes[0]!;
    this.b = nodes[1]!;
  }
  stamp(s: Stamper): void {
    if (this.st.burned) return;
    s.conductance(this.a, this.b, 1 / this.r);
  }
  pinCurrents(x: Float64Array): number[] {
    if (this.st.burned) return [0, 0];
    const i = (nv(x, this.a) - nv(x, this.b)) / this.r;
    return [i, -i];
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    const v = nv(x, this.a) - nv(x, this.b);
    switch (this.comp.kind) {
      case "resistor":
        return (v * v) / this.r / numParam(this.p, "powerRating", 0.25);
      case "buzzer":
      case "dc_motor":
        return Math.abs(v) / numParam(this.p, "maxVoltage", 12);
      default:
        return 0;
    }
  }
  protected override limits(x: Float64Array): Limit[] {
    const v = nv(x, this.a) - nv(x, this.b);
    switch (this.comp.kind) {
      case "resistor":
        return [
          {
            what: "power dissipation",
            actual: (v * v) / this.r,
            limit: numParam(this.p, "powerRating", 0.25),
            unit: "watt",
            hint: `It carried ${eng(v / this.r, "amp")} at ${eng(v, "volt")}. Use a higher-wattage resistor, or a larger resistance to cut the current.`,
          },
        ];
      case "buzzer":
      case "dc_motor":
        return [{ what: "supply voltage", actual: v, limit: numParam(this.p, "maxVoltage", 12), unit: "volt", hint: "Power it from a lower voltage." }];
      default:
        return [];
    }
  }
  override aux(x: Float64Array): Record<string, number> {
    const v = nv(x, this.a) - nv(x, this.b);
    const out: Record<string, number> = { resistance: this.r };
    if (this.comp.kind === "dc_motor") out.speed = clamp(v / numParam(this.p, "maxVoltage", 12), -1.5, 1.5);
    if (this.comp.kind === "buzzer") out.active = Math.abs(v) > 1.5 && !this.st.burned ? 1 : 0;
    return out;
  }
}

export function resistanceOf(c: PlacedComponent): number {
  const p = c.params;
  switch (c.kind) {
    case "ldr": {
      const lux = Math.max(0.1, numParam(p, "lux", 100));
      return numParam(p, "r10lux", 10000) * Math.pow(10 / lux, numParam(p, "gamma", 0.7));
    }
    case "ntc": {
      const T = numParam(p, "temp", 25) + 273.15;
      return numParam(p, "r25", 10000) * Math.exp(numParam(p, "beta", 3950) * (1 / T - 1 / 298.15));
    }
    case "ptc": {
      const dT = numParam(p, "temp", 25) - 25;
      return numParam(p, "r25", 100) * Math.max(0.05, 1 + numParam(p, "alpha", 0.007) * dT);
    }
    case "buzzer":
    case "dc_motor":
      return numParam(p, "resistance", 100);
    default:
      return numParam(p, "resistance", 1000);
  }
}

export class PotentiometerDevice extends Device {
  private readonly ra: number;
  private readonly rb: number;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    const total = Math.max(1, numParam(comp.params, "resistance", 10000));
    const w = clamp(numParam(comp.params, "wiper", 50) / 100, 0, 1);
    const floor = Math.max(0.05, total * 1e-4);
    this.ra = Math.max(floor, total * w);
    this.rb = Math.max(floor, total * (1 - w));
  }
  stamp(s: Stamper): void {
    const [a, b, w] = this.nodes as [number, number, number];
    s.conductance(a, w, 1 / this.ra);
    s.conductance(w, b, 1 / this.rb);
  }
  pinCurrents(x: Float64Array): number[] {
    const [a, b, w] = this.nodes as [number, number, number];
    const iaw = (nv(x, a) - nv(x, w)) / this.ra;
    const iwb = (nv(x, w) - nv(x, b)) / this.rb;
    return [iaw, -iwb, iwb - iaw];
  }
}

/**
 * Integration weight of the θ-method used for C and L. θ = 0.5 is the trapezoidal rule (second order, no numerical
 * damping, but rings after abrupt switching); θ = 1 is backward Euler (heavily damped). A slight bias keeps resonant
 * circuits accurate while still damping switching artefacts.
 */
export const THETA = 0.55;
export const THETA_R = (1 - THETA) / THETA;

export class CapacitorDevice extends Device {
  private readonly c: number;
  private readonly a: number;
  private readonly b: number;
  private readonly polar: boolean;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.c = Math.max(1e-15, numParam(comp.params, "capacitance", 1e-6));
    this.a = nodes[0]!;
    this.b = nodes[1]!;
    this.polar = comp.kind !== "cap_ceramic";
    this.thermalGain = 8;
  }
  stamp(s: Stamper, ctx: StepCtx): void {
    if (this.st.burned) {
      // Tantalum fails short, everything else fails open.
      if (this.comp.kind === "cap_tantalum") s.conductance(this.a, this.b, 100);
      return;
    }
    if (ctx.dc) return;
    const g = this.c / (THETA * ctx.dt);
    s.branch(this.a, this.b, g, -g * (this.st.n.v ?? 0) - THETA_R * (this.st.n.i ?? 0));
  }
  pinCurrents(x: Float64Array, ctx: StepCtx): number[] {
    if (this.st.burned) {
      if (this.comp.kind === "cap_tantalum") {
        const i = (nv(x, this.a) - nv(x, this.b)) * 100;
        return [i, -i];
      }
      return [0, 0];
    }
    if (ctx.dc || ctx.dt <= 0) return [0, 0];
    const v = nv(x, this.a) - nv(x, this.b);
    const i = (this.c / (THETA * ctx.dt)) * (v - (this.st.n.v ?? 0)) - THETA_R * (this.st.n.i ?? 0);
    return [i, -i];
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    const v = nv(x, this.a) - nv(x, this.b);
    const rating = numParam(this.p, "voltageRating", 50);
    if (v >= 0) return v / rating;
    return this.polar ? -v / 1.5 : -v / rating;
  }
  protected override limits(x: Float64Array): Limit[] {
    const v = nv(x, this.a) - nv(x, this.b);
    if (v >= 0) {
      return [{ what: "voltage", actual: v, limit: numParam(this.p, "voltageRating", 50), unit: "volt", hint: "Choose a capacitor with a higher voltage rating." }];
    }
    if (this.polar) {
      return [{ what: "reverse voltage", actual: -v, limit: 1.5, unit: "volt", hint: "Polarised capacitors must not be connected backwards: swap the + and − terminals." }];
    }
    return [{ what: "voltage", actual: -v, limit: numParam(this.p, "voltageRating", 50), unit: "volt", hint: "Choose a capacitor with a higher voltage rating." }];
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    this.st.n.i = this.burned ? 0 : this.pinCurrents(x, ctx)[0]!;
    this.st.n.v = nv(x, this.a) - nv(x, this.b);
  }
  private get burned(): boolean {
    return this.st.burned;
  }
  override aux(x: Float64Array): Record<string, number> {
    const v = nv(x, this.a) - nv(x, this.b);
    const e = 0.5 * this.c * v * v;
    return { charge: this.c * v, energy: e, fill: clamp(Math.abs(v) / numParam(this.p, "voltageRating", 50), 0, 1) };
  }
}

export class InductorDevice extends Device {
  private readonly l: number;
  private readonly dcr: number;
  private readonly a: number;
  private readonly b: number;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.l = Math.max(1e-12, numParam(comp.params, "inductance", 1e-2));
    this.dcr = Math.max(1e-3, numParam(comp.params, "dcr", 0.5));
    this.a = nodes[0]!;
    this.b = nodes[1]!;
    this.thermalGain = 6;
  }
  private companion(ctx: StepCtx): { g: number; j: number } {
    if (ctx.dc) return { g: 1 / this.dcr, j: 0 };
    const k = this.l / (THETA * ctx.dt);
    const g = 1 / (this.dcr + k);
    return { g, j: g * (k * (this.st.n.i ?? 0) + THETA_R * (this.st.n.vl ?? 0)) };
  }
  stamp(s: Stamper, ctx: StepCtx): void {
    if (this.st.burned) return;
    const { g, j } = this.companion(ctx);
    s.branch(this.a, this.b, g, j);
  }
  pinCurrents(x: Float64Array, ctx: StepCtx): number[] {
    if (this.st.burned) return [0, 0];
    const { g, j } = this.companion(ctx);
    const i = g * (nv(x, this.a) - nv(x, this.b)) + j;
    return [i, -i];
  }
  override stress(x: Float64Array, ctx: StepCtx): number {
    if (this.st.burned) return 0;
    return Math.abs(this.pinCurrents(x, ctx)[0]!) / numParam(this.p, "currentRating", 1);
  }
  protected override limits(x: Float64Array, ctx: StepCtx): Limit[] {
    return [
      {
        what: "current",
        actual: this.pinCurrents(x, ctx)[0]!,
        limit: numParam(this.p, "currentRating", 1),
        unit: "amp",
        hint: "At DC an inductor is only its winding resistance, so add series resistance or use a part with a higher current rating.",
      },
    ];
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    const i = this.pinCurrents(x, ctx)[0]!;
    this.st.n.i = i;
    // voltage across the ideal inductance (terminal voltage minus the winding resistance drop)
    this.st.n.vl = ctx.dc ? 0 : nv(x, this.a) - nv(x, this.b) - this.dcr * i;
  }
}

// ───────────────────────── sources ─────────────────────────

/** Rise / fall time of generated edges as a fraction of the period (a perfectly vertical edge is not physical). */
const EDGE_FRAC = 0.002;

/** Peak amplitude implied by the "amplitude" field and its unit selector (peak / rms / peak-to-peak). */
export function peakAmplitude(p: Params, fallback: number): number {
  const a = numParam(p, "amplitude", fallback);
  const t = strParam(p, "ampType", "peak");
  return t === "rms" ? a * Math.SQRT2 : t === "pp" ? a / 2 : a;
}

type Wave = "sine" | "square" | "triangle" | "sawtooth";

function waveOf(p: Params): { wave: Wave; duty: number } {
  const w = strParam(p, "waveform", "square");
  const duty = clamp(numParam(p, "duty", 50) / 100, 0.01, 0.99);
  if (w === "sine" || w === "triangle" || w === "sawtooth") return { wave: w, duty };
  return { wave: "square", duty }; // "square" and the legacy "pwm" are both a pulse train with adjustable duty
}

/** Normalised waveform shape in [-1, 1] at cycle phase `ph` ∈ [0, 1). */
function shape(wave: Wave, duty: number, ph: number): number {
  const e = EDGE_FRAC;
  switch (wave) {
    case "sine":
      return Math.sin(2 * Math.PI * ph);
    case "triangle":
      return ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
    case "sawtooth":
      // rises from −1 to +1 over the cycle, then falls back quickly
      if (ph < 1 - e) return -1 + (2 * ph) / (1 - e);
      return 1 - (2 * (ph - (1 - e))) / e;
    default: {
      if (ph < e) return -1 + (2 * ph) / e;
      if (ph < duty) return 1;
      if (ph < duty + e) return 1 - (2 * (ph - duty)) / e;
      return -1;
    }
  }
}

export function sourceValue(c: PlacedComponent, t: number): number {
  const p = c.params;
  switch (c.kind) {
    case "vac": {
      const f = numParam(p, "frequency", 50);
      return numParam(p, "offset", 0) + peakAmplitude(p, 5) * Math.sin(2 * Math.PI * f * t + (numParam(p, "phase", 0) * Math.PI) / 180);
    }
    case "sigen": {
      const f = Math.max(1e-6, numParam(p, "frequency", 1));
      const ph = (((t * f + numParam(p, "phase", 0) / 360) % 1) + 1) % 1;
      const { wave, duty } = waveOf(p);
      return numParam(p, "offset", 0) + peakAmplitude(p, 2.5) * shape(wave, duty, ph);
    }
    default:
      return numParam(p, "voltage", 5);
  }
}

/** Seconds until the next waveform corner (edge start / end, peak) of a generator; Infinity for smooth sources. */
export function nextBreakpoint(c: PlacedComponent, t: number): number {
  if (c.kind !== "sigen") return Infinity;
  const p = c.params;
  const f = Math.max(1e-6, numParam(p, "frequency", 1));
  const { wave, duty } = waveOf(p);
  if (wave === "sine") return Infinity;
  const x = t * f + numParam(p, "phase", 0) / 360;
  const ph = x - Math.floor(x);
  const e = EDGE_FRAC;
  const bps = wave === "triangle" ? [0, 0.25, 0.75, 1] : wave === "sawtooth" ? [0, 1 - e, 1] : [0, e, duty, duty + e, 1];
  for (const b of bps) {
    const d = b - ph;
    if (d > 1e-9) return d / f;
  }
  return (1 - ph) / f + 1e-9;
}

export class VoltageSourceDevice extends Device {
  private readonly rint: number;
  private readonly pN: number;
  private readonly nN: number;
  /** Bench supply with constant-current limiting: smooth tanh output characteristic. */
  private readonly cc: boolean;
  private readonly ilim: number;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.rint = Math.max(0, numParam(comp.params, "rint", 0));
    this.pN = nodes[0]!;
    this.nN = nodes[1]!;
    this.thermalGain = 0;
    this.ilim = numParam(comp.params, "currentLimit", Infinity);
    this.cc = comp.kind === "vdc" && Number.isFinite(this.ilim) && this.ilim > 0 && this.rint >= 1e-3;
    this.nonlinear = this.cc;
    this.branches = this.cc ? 0 : this.rint < 1e-3 ? 1 : 0;
  }
  private value(ctx: StepCtx): number {
    return sourceValue(this.comp, ctx.t) * ctx.srcScale;
  }
  /** Land exactly on the corners of square / pulse / saw / triangle waveforms. */
  override maxStep(t: number): number {
    return nextBreakpoint(this.comp, t);
  }
  private get g(): number {
    return 1 / Math.max(this.rint, 1e-3);
  }
  /** Current delivered out of the + terminal at terminal voltage vd. */
  private ccOut(vt: number, vd: number): { i: number; slope: number } {
    const u = (this.g * (vt - vd)) / this.ilim;
    const th = Math.tanh(u);
    // small slope floor keeps Newton from stalling on the flat (saturated) part of the curve
    return { i: this.ilim * th, slope: this.g * (1 - th * th + 2e-3) };
  }
  stamp(s: Stamper, ctx: StepCtx): void {
    const v = this.value(ctx);
    this.st.n.v = v;
    if (this.cc) return;
    if (this.branches === 1) {
      s.voltageSource(this.branchBase, this.pN, this.nN, v);
    } else {
      const g = 1 / this.rint;
      s.branch(this.pN, this.nN, g, -g * v);
    }
  }
  override stampNL(s: Stamper, x: Float64Array, ctx: StepCtx): boolean {
    if (!this.cc) return false;
    const vt = this.st.n.v ?? 0;
    const vnew = nv(x, this.pN) - nv(x, this.nN);
    // Limit the terminal-voltage step to a few knee widths so Newton can't leap across the
    // sharp current-limit corner (knee width = Ilim / g).
    const lim = Math.max(0.3, (4 * this.ilim) / this.g);
    if (this.st.n.tstep !== ctx.t) {
      this.st.n.tstep = ctx.t;
      this.st.n.damp = 1;
      this.st.n.dir = 0;
    }
    const vold = this.st.n.vd ?? vnew;
    const raw = vnew - vold;
    const dir = Math.sign(raw);
    // Damp when the iteration ping-pongs across the sharp current-limit knee.
    let damp = this.st.n.damp ?? 1;
    if (dir !== 0 && dir === -(this.st.n.dir ?? 0)) damp = Math.max(damp * 0.5, 1 / 128);
    else damp = Math.min(1, damp * 1.3);
    this.st.n.damp = damp;
    if (dir !== 0) this.st.n.dir = dir;
    const step = Math.max(-lim, Math.min(lim, raw * damp));
    const vd = vold + step;
    this.st.n.vd = vd;
    const { i, slope } = this.ccOut(vt, vd);
    // current p→n through the element = −i_out; linearised about vd
    s.branch(this.pN, this.nN, slope, -i - slope * vd);
    return Math.abs(vd - vnew) > 1e-7 + 1e-5 * Math.abs(vnew);
  }
  pinCurrents(x: Float64Array): number[] {
    let i: number;
    if (this.cc) i = -this.ccOut(this.st.n.v ?? 0, nv(x, this.pN) - nv(x, this.nN)).i;
    else if (this.branches === 1) i = x[this.branchIndexAbs]!;
    else i = (nv(x, this.pN) - nv(x, this.nN) - (this.st.n.v ?? 0)) / this.rint;
    return [i, -i];
  }
  override aux(x: Float64Array): Record<string, number> {
    const i = this.pinCurrents(x)[0]!;
    // constant-current mode once the output is within 3 % of the limit
    const limited = this.cc ? (-i >= this.ilim * 0.97 ? 1 : 0) : 0;
    return { supplied: -i, setpoint: this.st.n.v ?? 0, limited };
  }
}

// ───────────────────────── switches ─────────────────────────

export class SwitchDevice extends Device {
  private readonly pairs: [number, number, boolean][] = [];
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.thermalGain = 0;
    if (comp.kind === "dip_switch") {
      for (let i = 1; i <= 4; i++) {
        this.pairs.push([this.pinNode(`a${i}`), this.pinNode(`b${i}`), boolParam(comp.params, `s${i}`)]);
      }
    } else {
      this.pairs.push([nodes[0]!, nodes[1]!, boolParam(comp.params, "closed")]);
    }
  }
  stamp(s: Stamper): void {
    for (const [a, b, closed] of this.pairs) s.conductance(a, b, closed ? G_CLOSED : G_OPEN);
  }
  pinCurrents(x: Float64Array): number[] {
    if (this.comp.kind === "dip_switch") {
      const out = new Array<number>(8).fill(0);
      this.pairs.forEach(([a, b, closed], k) => {
        const i = (nv(x, a) - nv(x, b)) * (closed ? G_CLOSED : G_OPEN);
        out[k] = i;
        out[k + 4] = -i;
      });
      return out;
    }
    const [a, b, closed] = this.pairs[0]!;
    const i = (nv(x, a) - nv(x, b)) * (closed ? G_CLOSED : G_OPEN);
    return [i, -i];
  }
  override aux(): Record<string, number> {
    return { closed: this.pairs[0]![2] ? 1 : 0 };
  }
}

export class RelayDevice extends Device {
  private readonly rc: number;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.rc = Math.max(1, numParam(comp.params, "coilResistance", 400));
    this.thermalGain = 0;
  }
  private get on(): boolean {
    return this.st.f.on === true;
  }
  stamp(s: Stamper): void {
    const c1 = this.pinNode("c1");
    const c2 = this.pinNode("c2");
    s.conductance(c1, c2, 1 / this.rc);
    s.conductance(this.pinNode("com"), this.pinNode("no"), this.on ? 20 : G_OPEN);
    s.conductance(this.pinNode("com"), this.pinNode("nc"), this.on ? G_OPEN : 20);
  }
  pinCurrents(x: Float64Array): number[] {
    const v = (id: string): number => nv(x, this.pinNode(id));
    const icoil = (v("c1") - v("c2")) / this.rc;
    const ino = (v("com") - v("no")) * (this.on ? 20 : G_OPEN);
    const inc = (v("com") - v("nc")) * (this.on ? G_OPEN : 20);
    // pin order: c1, c2, nc, com, no
    return [icoil, -icoil, -inc, ino + inc, -ino];
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    const vc = Math.abs(nv(x, this.pinNode("c1")) - nv(x, this.pinNode("c2")));
    const rated = numParam(this.p, "ratedVoltage", 5);
    if (vc >= numParam(this.p, "pullIn", 0.7) * rated) this.st.f.on = true;
    else if (vc <= numParam(this.p, "dropOut", 0.1) * rated) this.st.f.on = false;
  }
  override aux(): Record<string, number> {
    return { energised: this.on ? 1 : 0 };
  }
}

// ───────────────────────── diodes ─────────────────────────

export function pnjlim(vnew: number, vold: number, vt: number, vcrit: number): number {
  if (vnew > vcrit && Math.abs(vnew - vold) > 2 * vt) {
    if (vold > 0) {
      const arg = 1 + (vnew - vold) / vt;
      return arg > 0 ? vold + vt * Math.log(arg) : vcrit;
    }
    return vt * Math.log(vnew / vt);
  }
  return vnew;
}

export class Junction {
  readonly is: number;
  readonly nvt: number;
  readonly vcrit: number;
  /** Reverse-breakdown parameters (zener). */
  readonly zEff: number;
  readonly zis = 1e-9;
  readonly znvt = 0.5 * VT;
  constructor(vf: number, n: number, vz = Infinity) {
    this.nvt = n * VT;
    this.is = 0.01 / (Math.exp(vf / this.nvt) - 1);
    this.vcrit = this.nvt * Math.log(this.nvt / (Math.SQRT2 * this.is));
    this.zEff = Number.isFinite(vz) ? Math.max(0.1, vz - 0.208) : Infinity;
  }
  limit(vnew: number, vold: number): number {
    if (Number.isFinite(this.zEff) && vnew < -this.zEff * 0.5) {
      const vr = pnjlim(-vnew - this.zEff, -vold - this.zEff, this.znvt, 0.1);
      return -vr - this.zEff;
    }
    return pnjlim(vnew, vold, this.nvt, this.vcrit);
  }
  eval(v: number): { i: number; g: number } {
    const x = v / this.nvt;
    let i = this.is * (expl(x) - 1) + GMIN * v;
    let g = (this.is / this.nvt) * dexpl(x) + GMIN;
    if (Number.isFinite(this.zEff)) {
      const xr = (-v - this.zEff) / this.znvt;
      i -= this.zis * (expl(xr) - 1);
      g += (this.zis / this.znvt) * dexpl(xr);
    }
    return { i, g };
  }
}

interface DiodeLeg {
  a: number;
  k: number;
  j: Junction;
  key: string;
}

/** Single diode, LED, zener, Schottky. */
export class DiodeDevice extends Device {
  private readonly leg: DiodeLeg;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.nonlinear = true;
    const p = comp.params;
    const kind = comp.kind;
    const n = kind === "led" ? 2 : kind === "schottky" ? 1.05 : 1;
    const vz = kind === "zener" ? numParam(p, "vz", 5.1) : Infinity;
    this.leg = { a: nodes[0]!, k: nodes[1]!, j: new Junction(numParam(p, "vf", 0.7), n, vz), key: "d0" };
    this.thermalGain = kind === "led" ? 12 : 6;
  }
  stamp(): void {
    /* nonlinear only */
  }
  override stampNL(s: Stamper, x: Float64Array): boolean {
    if (this.st.burned) return false;
    const { a, k, j } = this.leg;
    const vnew = nv(x, a) - nv(x, k);
    const vold = this.st.n.vd ?? 0;
    const v = j.limit(vnew, vold);
    const { i, g } = j.eval(v);
    s.branch(a, k, g, i - g * v);
    this.st.n.vd = v;
    return Math.abs(v - vnew) > 1e-9;
  }
  private current(x: Float64Array): number {
    if (this.st.burned) return 0;
    return this.leg.j.eval(nv(x, this.leg.a) - nv(x, this.leg.k)).i;
  }
  pinCurrents(x: Float64Array): number[] {
    const i = this.current(x);
    return [i, -i];
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    const i = this.current(x);
    const v = nv(x, this.leg.a) - nv(x, this.leg.k);
    if (this.comp.kind === "zener") return Math.abs(i * v) / numParam(this.p, "maxPower", 0.5);
    return i > 0 ? i / numParam(this.p, "maxCurrent", 1) : 0;
  }
  protected override limits(x: Float64Array): Limit[] {
    const i = this.current(x);
    const v = nv(x, this.leg.a) - nv(x, this.leg.k);
    if (this.comp.kind === "zener") {
      return [
        {
          what: "power dissipation",
          actual: Math.abs(i * v),
          limit: numParam(this.p, "maxPower", 0.5),
          unit: "watt",
          hint: "Put a series resistor in front of the zener to limit its current.",
        },
      ];
    }
    const led = this.comp.kind === "led";
    return [
      {
        what: "forward current",
        actual: Math.max(0, i),
        limit: numParam(this.p, "maxCurrent", 1),
        unit: "amp",
        hint: led
          ? "An LED has almost no resistance once it conducts: always add a series resistor, R ≥ (Vsupply − Vf) / I_max."
          : "Limit the current with a series resistor or a part with a higher current rating.",
      },
    ];
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    this.st.n.vd = nv(x, this.leg.a) - nv(x, this.leg.k);
  }
  override aux(x: Float64Array): Record<string, number> {
    const i = this.current(x);
    return { brightness: this.comp.kind === "led" ? clamp(i / 0.015, 0, 1.6) : 0 };
  }
}

/** RGB LED / 7-segment: several anodes sharing one common cathode. */
export class DiodeArrayDevice extends Device {
  private readonly legs: DiodeLeg[] = [];
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.nonlinear = true;
    this.thermalGain = 12;
    const com = this.pinNode("com");
    const ids = comp.kind === "led_rgb" ? ["r", "g", "b"] : ["a", "b", "c", "d", "e", "f", "g", "dp"];
    const vfs: Record<string, number> =
      comp.kind === "led_rgb" ? { r: LED_VF.red!, g: LED_VF.green!, b: LED_VF.blue! } : {};
    for (const id of ids) {
      this.legs.push({
        a: this.pinNode(id),
        k: com,
        j: new Junction(vfs[id] ?? LED_VF.red!, 2),
        key: id,
      });
    }
  }
  stamp(): void {
    /* nonlinear only */
  }
  override stampNL(s: Stamper, x: Float64Array): boolean {
    if (this.st.burned) return false;
    let limited = false;
    for (const l of this.legs) {
      const vnew = nv(x, l.a) - nv(x, l.k);
      const vold = this.st.n[`v_${l.key}`] ?? 0;
      const v = l.j.limit(vnew, vold);
      const { i, g } = l.j.eval(v);
      s.branch(l.a, l.k, g, i - g * v);
      this.st.n[`v_${l.key}`] = v;
      if (Math.abs(v - vnew) > 1e-9) limited = true;
    }
    return limited;
  }
  private legCurrent(x: Float64Array, l: DiodeLeg): number {
    return this.st.burned ? 0 : l.j.eval(nv(x, l.a) - nv(x, l.k)).i;
  }
  pinCurrents(x: Float64Array): number[] {
    const byPin = new Map<number, number>();
    const out = new Array<number>(this.def.pins.length).fill(0);
    let common = 0;
    this.legs.forEach((l) => {
      const i = this.legCurrent(x, l);
      const idx = this.def.pins.findIndex((p) => p.id === l.key);
      out[idx] = i;
      common -= i;
      byPin.set(idx, i);
    });
    out[this.def.pins.findIndex((p) => p.id === "com")] = common;
    return out;
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    const max = numParam(this.p, "maxCurrent", 0.02);
    return Math.max(...this.legs.map((l) => this.legCurrent(x, l) / max), 0);
  }
  protected override limits(x: Float64Array): Limit[] {
    const max = numParam(this.p, "maxCurrent", 0.02);
    return this.legs.map((l) => ({
      what: `segment/LED ${l.key} current`,
      actual: this.legCurrent(x, l),
      limit: max,
      unit: "amp" as const,
      hint: "Every LED segment needs its own series resistor (about 330 Ω at 5 V).",
    }));
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    for (const l of this.legs) this.st.n[`v_${l.key}`] = nv(x, l.a) - nv(x, l.k);
  }
  override aux(x: Float64Array): Record<string, number> {
    const out: Record<string, number> = {};
    for (const l of this.legs) out[`b_${l.key}`] = clamp(this.legCurrent(x, l) / 0.01, 0, 1.6);
    return out;
  }
  override report(x: Float64Array, ctx: StepCtx): ComponentSnapshot {
    const base = super.report(x, ctx);
    base.current = this.legs.reduce((s, l) => s + this.legCurrent(x, l), 0);
    return base;
  }
}

// ───────────────────────── transistors ─────────────────────────

export class BjtDevice extends Device {
  private readonly sgn: 1 | -1;
  private readonly is = 1e-14;
  private readonly bf: number;
  private readonly br = 2;
  private readonly vcrit: number;
  private readonly nB: number;
  private readonly nC: number;
  private readonly nE: number;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.nonlinear = true;
    this.sgn = comp.kind === "bjt_pnp" ? -1 : 1;
    this.bf = Math.max(1, numParam(comp.params, "beta", 150));
    this.vcrit = VT * Math.log(VT / (Math.SQRT2 * this.is));
    this.nB = this.pinNode("b");
    this.nC = this.pinNode("c");
    this.nE = this.pinNode("e");
    this.thermalGain = 6;
  }
  stamp(): void {
    /* nonlinear only */
  }
  /** Terminal currents (into C, B, E) and their partials w.r.t. (vbe, vbc), NPN-oriented. */
  private model(vbe: number, vbc: number) {
    const ef = expl(vbe / VT);
    const er = expl(vbc / VT);
    const gf = (this.is / VT) * dexpl(vbe / VT);
    const gr = (this.is / VT) * dexpl(vbc / VT);
    const If = this.is * (ef - 1);
    const Ir = this.is * (er - 1);
    const k = 1 + 1 / this.br;
    const ic = If - Ir * k;
    const ib = If / this.bf + Ir / this.br;
    const ie = -(ic + ib);
    return {
      ic,
      ib,
      ie,
      // d/dvbe, d/dvbc
      dic: [gf, -gr * k] as const,
      dib: [gf / this.bf, gr / this.br] as const,
      die: [-(gf + gf / this.bf), -(-gr * k + gr / this.br)] as const,
    };
  }
  override stampNL(s: Stamper, x: Float64Array): boolean {
    if (this.st.burned) return false;
    const sg = this.sgn;
    const vbeN = sg * (nv(x, this.nB) - nv(x, this.nE));
    const vbcN = sg * (nv(x, this.nB) - nv(x, this.nC));
    const vbe = pnjlim(vbeN, this.st.n.vbe ?? 0, VT, this.vcrit);
    const vbc = pnjlim(vbcN, this.st.n.vbc ?? 0, VT, this.vcrit);
    this.st.n.vbe = vbe;
    this.st.n.vbc = vbc;
    const m = this.model(vbe, vbc);
    const terms: [number, number, readonly [number, number]][] = [
      [this.nC, m.ic, m.dic],
      [this.nB, m.ib, m.dib],
      [this.nE, m.ie, m.die],
    ];
    for (const [node, i0, d] of terms) {
      const ceq = i0 - d[0] * vbe - d[1] * vbc; // NPN-oriented constant
      // J wrt node voltages: vbe = sg(vB - vE), vbc = sg(vB - vC); current = sg * i'
      // d(sg·i')/dvB = d0 + d1 ; /dvE = -d0 ; /dvC = -d1 (sg² = 1)
      s.add(node, this.nB, d[0] + d[1]);
      s.add(node, this.nE, -d[0]);
      s.add(node, this.nC, -d[1]);
      s.rhs(node, -sg * ceq);
    }
    return Math.abs(vbe - vbeN) > 1e-9 || Math.abs(vbc - vbcN) > 1e-9;
  }
  private currents(x: Float64Array): { ic: number; ib: number; ie: number } {
    if (this.st.burned) return { ic: 0, ib: 0, ie: 0 };
    const sg = this.sgn;
    const m = this.model(sg * (nv(x, this.nB) - nv(x, this.nE)), sg * (nv(x, this.nB) - nv(x, this.nC)));
    return { ic: sg * m.ic, ib: sg * m.ib, ie: sg * m.ie };
  }
  pinCurrents(x: Float64Array): number[] {
    const { ic, ib, ie } = this.currents(x);
    // catalog order: b, c, e
    return [ib, ic, ie];
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    const { ic, ib, ie } = this.currents(x);
    const p = Math.abs(nv(x, this.nC) * ic + nv(x, this.nB) * ib + nv(x, this.nE) * ie);
    return Math.max(Math.abs(ic) / numParam(this.p, "maxIc", 0.2), p / numParam(this.p, "maxPower", 0.625));
  }
  protected override limits(x: Float64Array): Limit[] {
    const { ic, ib, ie } = this.currents(x);
    const p = Math.abs(nv(x, this.nC) * ic + nv(x, this.nB) * ib + nv(x, this.nE) * ie);
    return [
      { what: "collector current", actual: ic, limit: numParam(this.p, "maxIc", 0.2), unit: "amp", hint: "Reduce the load current or use a power transistor." },
      { what: "power dissipation", actual: p, limit: numParam(this.p, "maxPower", 0.625), unit: "watt", hint: "It sat in its linear region with high Vce × Ic: drive it fully on/off or add a heatsink / bigger part." },
    ];
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    this.st.n.vbe = this.sgn * (nv(x, this.nB) - nv(x, this.nE));
    this.st.n.vbc = this.sgn * (nv(x, this.nB) - nv(x, this.nC));
  }
  override report(x: Float64Array, ctx: StepCtx): ComponentSnapshot {
    const base = super.report(x, ctx);
    const { ic } = this.currents(x);
    base.current = ic;
    base.voltage = nv(x, this.nC) - nv(x, this.nE);
    return base;
  }
}

export class MosfetDevice extends Device {
  private readonly sgn: 1 | -1;
  private readonly vth: number;
  private readonly k: number;
  private readonly lambda = 0.02;
  private readonly nG: number;
  private readonly nD: number;
  private readonly nS: number;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.nonlinear = true;
    this.sgn = comp.kind === "pmos" ? -1 : 1;
    this.vth = Math.abs(numParam(comp.params, "vth", 2));
    this.k = Math.max(1e-6, numParam(comp.params, "kp", 1));
    this.nG = this.pinNode("g");
    this.nD = this.pinNode("d");
    this.nS = this.pinNode("s");
    this.thermalGain = 6;
  }
  stamp(s: Stamper): void {
    // Small drain–source leakage keeps floating drains well-posed.
    s.conductance(this.nD, this.nS, GMIN);
  }
  /** NMOS-oriented level-1 model with source/drain swap. Returns id (D→S) and partials. */
  private eval(vgs: number, vds: number): { id: number; dvgs: number; dvds: number } {
    if (vds >= 0) {
      const r = this.forward(vgs, vds);
      return { id: r.id, dvgs: r.gm, dvds: r.gds };
    }
    // reverse conduction: roles of D and S swap; vgd acts as vgs.
    const r = this.forward(vgs - vds, -vds);
    return { id: -r.id, dvgs: -r.gm, dvds: r.gm + r.gds };
  }
  private forward(vgs: number, vds: number): { id: number; gm: number; gds: number } {
    const vov = vgs - this.vth;
    if (vov <= 0) return { id: 0, gm: 0, gds: 0 };
    const lam = 1 + this.lambda * vds;
    if (vds < vov) {
      const core = vov * vds - (vds * vds) / 2;
      return {
        id: this.k * core * lam,
        gm: this.k * vds * lam,
        gds: this.k * (vov - vds) * lam + this.k * core * this.lambda,
      };
    }
    const core = 0.5 * vov * vov;
    return { id: this.k * core * lam, gm: this.k * vov * lam, gds: this.k * core * this.lambda };
  }
  override stampNL(s: Stamper, x: Float64Array): boolean {
    if (this.st.burned) return false;
    const sg = this.sgn;
    const vgsN = sg * (nv(x, this.nG) - nv(x, this.nS));
    const vdsN = sg * (nv(x, this.nD) - nv(x, this.nS));
    const ovgs = this.st.n.vgs ?? 0;
    const ovds = this.st.n.vds ?? 0;
    const vgs = ovgs + clamp(vgsN - ovgs, -1.5, 1.5);
    const vds = ovds + clamp(vdsN - ovds, -4, 4);
    this.st.n.vgs = vgs;
    this.st.n.vds = vds;
    const { id, dvgs, dvds } = this.eval(vgs, vds);
    const ceq = id - dvgs * vgs - dvds * vds;
    // I_D = sg·id'; partials w.r.t. node voltages (sg² = 1)
    s.add(this.nD, this.nG, dvgs);
    s.add(this.nD, this.nD, dvds);
    s.add(this.nD, this.nS, -(dvgs + dvds));
    s.rhs(this.nD, -sg * ceq);
    s.add(this.nS, this.nG, -dvgs);
    s.add(this.nS, this.nD, -dvds);
    s.add(this.nS, this.nS, dvgs + dvds);
    s.rhs(this.nS, sg * ceq);
    return Math.abs(vgs - vgsN) > 1e-9 || Math.abs(vds - vdsN) > 1e-9;
  }
  private drainCurrent(x: Float64Array): number {
    if (this.st.burned) return 0;
    const sg = this.sgn;
    const { id } = this.eval(sg * (nv(x, this.nG) - nv(x, this.nS)), sg * (nv(x, this.nD) - nv(x, this.nS)));
    return sg * id + (nv(x, this.nD) - nv(x, this.nS)) * GMIN;
  }
  pinCurrents(x: Float64Array): number[] {
    const id = this.drainCurrent(x);
    // catalog order: g, d, s
    return [0, id, -id];
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    const id = this.drainCurrent(x);
    const vds = nv(x, this.nD) - nv(x, this.nS);
    return Math.max(Math.abs(id) / numParam(this.p, "maxId", 10), Math.abs(id * vds) / numParam(this.p, "maxPower", 20));
  }
  protected override limits(x: Float64Array): Limit[] {
    const id = this.drainCurrent(x);
    const vds = nv(x, this.nD) - nv(x, this.nS);
    return [
      { what: "drain current", actual: id, limit: numParam(this.p, "maxId", 10), unit: "amp", hint: "Reduce the load current or use a bigger MOSFET." },
      { what: "power dissipation", actual: id * vds, limit: numParam(this.p, "maxPower", 20), unit: "watt", hint: "Drive the gate harder so it is fully on, or add a heatsink." },
    ];
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    this.st.n.vgs = this.sgn * (nv(x, this.nG) - nv(x, this.nS));
    this.st.n.vds = this.sgn * (nv(x, this.nD) - nv(x, this.nS));
  }
  override report(x: Float64Array, ctx: StepCtx): ComponentSnapshot {
    const base = super.report(x, ctx);
    base.current = this.drainCurrent(x);
    base.voltage = nv(x, this.nD) - nv(x, this.nS);
    return base;
  }
}

// ───────────────────────── behavioural ICs ─────────────────────────

/**
 * Behavioural nonlinear block with a numerical Jacobian: `fn` maps terminal voltages to
 * currents flowing INTO each terminal.
 */
export abstract class BehaviouralDevice extends Device {
  /** Homotopy level of the current Newton solve (1 = the real circuit). */
  protected h = 1;
  /** Behavioural blocks can be solved by continuation when plain Newton fails. */
  readonly stiff = true;
  protected abstract currents(v: number[]): number[];

  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.nonlinear = true;
  }
  stamp(): void {
    /* nonlinear only */
  }
  override stampNL(s: Stamper, x: Float64Array, ctx: StepCtx): boolean {
    this.h = ctx.homotopy;
    if (this.st.burned) return false;
    const n = this.nodes.length;
    // SPICE-style step limiting: never move the linearisation point more than DV per iteration.
    const DV = 2;
    let limited = false;
    const v0 = this.nodes.map((nd, j) => {
      const raw = nv(x, nd);
      const old = this.st.n[`bv${j}`];
      const v = old === undefined ? raw : old + clamp(raw - old, -DV, DV);
      if (Math.abs(v - raw) > 1e-9) limited = true;
      this.st.n[`bv${j}`] = v;
      return v;
    });
    const i0 = this.currents(v0);
    const J: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
    for (let j = 0; j < n; j++) {
      const h = 1e-6 * Math.max(1, Math.abs(v0[j]!));
      const vp = v0.slice();
      const vm = v0.slice();
      vp[j] = v0[j]! + h;
      vm[j] = v0[j]! - h;
      const ip = this.currents(vp);
      const im = this.currents(vm);
      for (let k = 0; k < n; k++) J[k]![j] = (ip[k]! - im[k]!) / (2 * h);
    }
    for (let k = 0; k < n; k++) {
      let ceq = i0[k]!;
      for (let j = 0; j < n; j++) {
        s.add(this.nodes[k]!, this.nodes[j]!, J[k]![j]!);
        ceq -= J[k]![j]! * v0[j]!;
      }
      s.rhs(this.nodes[k]!, -ceq);
    }
    return limited;
  }
  pinCurrents(x: Float64Array): number[] {
    if (this.st.burned) return this.nodes.map(() => 0);
    return this.currents(this.nodes.map((nd) => nv(x, nd)));
  }
}

export class OpAmpDevice extends BehaviouralDevice {
  private readonly gain: number;
  private readonly hiHead: number;
  private readonly loHead: number;
  private readonly rout = 50;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.gain = clamp(numParam(comp.params, "gain", 1e5), 1e3, 1e6);
    this.hiHead = numParam(comp.params, "headroom", 1.5);
    this.loHead = numParam(comp.params, "lowHeadroom", comp.kind === "lm358" ? 0.05 : this.hiHead);
    this.thermalGain = 4;
  }
  private target(v: number[]): number | null {
    const [vp, vn, vo, vcc, vee] = v as [number, number, number, number, number];
    const hi = vcc - this.hiHead;
    const lo = vee + this.loHead;
    if (hi - lo < 0.5) return null;
    const mid = (hi + lo) / 2;
    const half = (hi - lo) / 2;
    void vo;
    return mid + half * Math.tanh((Math.pow(this.gain, this.h) * (vp - vn)) / half);
  }
  protected currents(v: number[]): number[] {
    const [, , vo, vcc, vee] = v as [number, number, number, number, number];
    const vt = this.target(v);
    const iq = 1e-3 * clamp((vcc - vee) / 3, 0, 1);
    const isrc = vt === null ? 0 : (vt - vo) / this.rout;
    // pins: inp, inn, out, vcc, vee
    return [0, 0, -isrc, iq + Math.max(0, isrc), -iq + Math.min(0, isrc)];
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    const vcc = nv(x, this.nodes[3]!);
    const vee = nv(x, this.nodes[4]!);
    return Math.max((vcc - vee) / 36, Math.abs(this.pinCurrents(x)[2]!) / 0.05);
  }
  protected override limits(x: Float64Array): Limit[] {
    return [
      { what: "supply voltage", actual: nv(x, this.nodes[3]!) - nv(x, this.nodes[4]!), limit: 36, unit: "volt", hint: "Lower the supply rails." },
      { what: "output current", actual: this.pinCurrents(x)[2]!, limit: 0.05, unit: "amp", hint: "The output is short-circuited or loaded too heavily: add a series resistor or a buffer transistor." },
    ];
  }
  override report(x: Float64Array, ctx: StepCtx): ComponentSnapshot {
    const base = super.report(x, ctx);
    base.current = this.pinCurrents(x)[2]!;
    base.voltage = nv(x, this.nodes[2]!);
    return base;
  }
  override aux(x: Float64Array): Record<string, number> {
    return { out: nv(x, this.nodes[2]!), diff: nv(x, this.nodes[0]!) - nv(x, this.nodes[1]!) };
  }
}

export class RegulatorDevice extends BehaviouralDevice {
  private readonly vset: number;
  private readonly drop: number;
  private readonly imax: number;
  private readonly adjustable: boolean;
  private readonly rout = 0.02;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.adjustable = comp.kind === "lm317";
    this.vset = numParam(comp.params, "vout", 5);
    this.drop = numParam(comp.params, "dropout", 2);
    this.imax = Math.max(0.05, numParam(comp.params, "maxCurrent", 1.5));
    this.thermalGain = 3;
  }
  private idx(id: string): number {
    return this.def.pins.findIndex((p) => p.id === id);
  }
  protected currents(v: number[]): number[] {
    const vin = v[this.idx("in")]!;
    const vout = v[this.idx("out")]!;
    const refIdx = this.adjustable ? this.idx("adj") : this.idx("gnd");
    const vref = v[refIdx]!;
    const s = !this.adjustable && this.vset < 0 ? -1 : 1;
    const vinRel = s * (vin - vref);
    let vt: number;
    if (this.adjustable) vt = Math.min(vref + 1.25, vin - this.drop);
    else vt = vref + s * Math.max(0, Math.min(Math.abs(this.vset), vinRel - this.drop));
    if (this.adjustable && vin - vref < 3) vt = vref;
    // Piecewise-linear Thevenin source. Over-current is not clamped (a hard limiter makes
    // Newton oscillate); it is reported as stress and destroys the part like any other overload.
    const isrc = (vt - vout) / this.rout;
    const out = new Array<number>(3).fill(0);
    out[this.idx("out")] = -isrc;
    if (this.adjustable) {
      const iadj = -50e-6;
      out[this.idx("adj")] = iadj;
      out[this.idx("in")] = isrc + 50e-6;
    } else {
      const iq = vinRel > 2 ? 5e-3 : 0;
      out[this.idx("in")] = isrc + s * iq;
      out[this.idx("gnd")] = -s * iq;
    }
    return out;
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    const cur = this.pinCurrents(x);
    const iout = Math.abs(cur[this.idx("out")]!);
    const pd = Math.abs((nv(x, this.nodes[this.idx("in")]!) - nv(x, this.nodes[this.idx("out")]!)) * iout);
    return Math.max(iout / this.imax, pd / 25);
  }
  protected override limits(x: Float64Array): Limit[] {
    const cur = this.pinCurrents(x);
    const iout = Math.abs(cur[this.idx("out")]!);
    const dv = nv(x, this.nodes[this.idx("in")]!) - nv(x, this.nodes[this.idx("out")]!);
    return [
      { what: "output current", actual: iout, limit: this.imax, unit: "amp", hint: "Reduce the load or use a higher-current regulator." },
      { what: "power dissipation", actual: Math.abs(dv * iout), limit: 25, unit: "watt", hint: "(Vin − Vout) × I is turned into heat: lower the input voltage or use a switching regulator." },
    ];
  }
  override report(x: Float64Array, ctx: StepCtx): ComponentSnapshot {
    const base = super.report(x, ctx);
    base.current = this.pinCurrents(x)[this.idx("in")]!;
    base.voltage = nv(x, this.nodes[this.idx("out")]!) - nv(x, this.nodes[this.idx(this.adjustable ? "adj" : "gnd")]!);
    return base;
  }
}

/** Combinational gate with one step of propagation delay and Thevenin output. */
export class GateDevice extends Device {
  private readonly supply: number;
  private readonly rout: number;
  private readonly fn: string;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.supply = numParam(comp.params, "supply", 5);
    this.rout = Math.max(1, numParam(comp.params, "rout", 50));
    this.fn = strParam(comp.params, "fn", "and");
    this.thermalGain = 0;
  }
  private logic(a: boolean, b: boolean): boolean {
    switch (this.fn) {
      case "and":
        return a && b;
      case "or":
        return a || b;
      case "not":
        return !a;
      case "nand":
        return !(a && b);
      case "nor":
        return !(a || b);
      case "xor":
        return a !== b;
      default:
        return false;
    }
  }
  stamp(s: Stamper): void {
    const y = this.pinNode("y");
    const g = 1 / this.rout;
    const vt = this.st.f.out ? this.supply : 0;
    s.branch(y, -1, g, -g * vt);
  }
  pinCurrents(x: Float64Array): number[] {
    const out = new Array<number>(this.def.pins.length).fill(0);
    const yi = this.def.pins.findIndex((p) => p.id === "y");
    out[yi] = ((nv(x, this.pinNode("y")) - (this.st.f.out ? this.supply : 0)) / this.rout);
    return out;
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    const th = this.supply / 2;
    const a = nv(x, this.pinNode("a")) > th;
    const b = this.fn === "not" ? false : nv(x, this.pinNode("b")) > th;
    this.st.f.out = this.logic(a, b);
  }
  override aux(): Record<string, number> {
    return { out: this.st.f.out ? 1 : 0 };
  }
}

export class Timer555Device extends Device {
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.thermalGain = 8;
  }
  private get q(): boolean {
    return this.st.f.q === true;
  }
  private n(id: string): number {
    return this.pinNode(id);
  }
  private powered(x: Float64Array): boolean {
    return nv(x, this.n("p8")) - nv(x, this.n("p1")) > 1.5;
  }
  /** Output stage: Thevenin leg to GND (low) or to VCC (high), 8–12 Ω. */
  private outLeg(): { ref: string; g: number; j: (g: number) => number } {
    return this.q
      ? { ref: "p8", g: 1 / 12, j: (g) => 0.5 * g }
      : { ref: "p1", g: 1 / 8, j: (g) => -0.05 * g };
  }
  stamp(s: Stamper): void {
    const vcc = this.n("p8");
    const gnd = this.n("p1");
    s.conductance(vcc, gnd, 1 / 2500); // quiescent supply current
    s.conductance(vcc, this.n("p5"), 1 / 5000); // divider (5 k + 10 k)
    s.conductance(this.n("p5"), gnd, 1 / 10000);
    s.conductance(vcc, this.n("p4"), 1 / 100000); // reset pull-up
    const leg = this.outLeg();
    s.branch(this.n("p3"), this.n(leg.ref), leg.g, leg.j(leg.g));
    s.conductance(this.n("p7"), gnd, this.q ? G_OPEN : 1 / 20); // discharge transistor
  }
  pinCurrents(x: Float64Array): number[] {
    const v = (id: string): number => nv(x, this.n(id));
    const gnd = v("p1");
    const vcc = v("p8");
    const iq = (vcc - gnd) / 2500;
    const idiv1 = (vcc - v("p5")) / 5000;
    const idiv2 = (v("p5") - gnd) / 10000;
    const irst = (vcc - v("p4")) / 100000;
    const leg = this.outLeg();
    const iout = leg.g * (v("p3") - v(leg.ref)) + leg.j(leg.g); // into pin 3
    const idis = (v("p7") - gnd) * (this.q ? G_OPEN : 1 / 20);
    const out = new Array<number>(8).fill(0);
    out[7] = iq + idiv1 + irst + (this.q ? -iout : 0);
    out[4] = -idiv1 + idiv2;
    out[3] = -irst;
    out[2] = iout;
    out[6] = idis;
    // Everything that entered the other pins must leave through GND.
    out[0] = -(out[2]! + out[3]! + out[4]! + out[6]! + out[7]!);
    return out;
  }
  override stress(x: Float64Array): number {
    return (nv(x, this.n("p8")) - nv(x, this.n("p1"))) / 18;
  }
  protected override limits(x: Float64Array): Limit[] {
    return [{ what: "supply voltage", actual: nv(x, this.n("p8")) - nv(x, this.n("p1")), limit: 18, unit: "volt", hint: "A 555 runs from 4.5 – 16 V; use a lower supply." }];
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    if (!this.powered(x)) {
      this.st.f.q = false;
      return;
    }
    const gnd = nv(x, this.n("p1"));
    const ctrl = nv(x, this.n("p5")) - gnd;
    const thr = nv(x, this.n("p6")) - gnd;
    const trg = nv(x, this.n("p2")) - gnd;
    const reset = nv(x, this.n("p4")) - gnd;
    if (reset < 0.7) this.st.f.q = false;
    else if (trg < ctrl / 2) this.st.f.q = true;
    else if (thr > ctrl) this.st.f.q = false;
  }
  override aux(): Record<string, number> {
    return { q: this.q ? 1 : 0 };
  }
}

// ───────────────────────── instruments ─────────────────────────

export class MeterDevice extends Device {
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.thermalGain = 0;
  }
  private get mode(): string {
    const m = strParam(this.p, "mode", "voltage");
    return m === "voltage_ac" ? "voltage" : m === "current_ac" ? "current" : m;
  }
  /** AC modes report the true RMS over a sliding window (exponential, τ = 0.1 s of circuit time). */
  private get ac(): boolean {
    return strParam(this.p, "mode", "voltage").endsWith("_ac");
  }
  stamp(s: Stamper): void {
    if (this.comp.kind === "dmm") {
      const a = this.pinNode("in");
      const b = this.pinNode("com");
      if (this.mode === "voltage") s.conductance(a, b, 1e-7);
      else if (this.mode === "current") s.conductance(a, b, 100);
      else s.branch(a, b, 1e-4, -1e-4 * 1);
    } else if (this.comp.kind === "scope") {
      const g = this.pinNode("gnd");
      s.conductance(this.pinNode("ch1"), g, 1e-6);
      s.conductance(this.pinNode("ch2"), g, 1e-6);
    } else {
      const g = this.pinNode("gnd");
      for (let i = 0; i < 8; i++) s.conductance(this.pinNode(`d${i}`), g, 1e-7);
    }
  }
  pinCurrents(x: Float64Array): number[] {
    const out = new Array<number>(this.def.pins.length).fill(0);
    if (this.comp.kind === "dmm") {
      const v = nv(x, this.pinNode("in")) - nv(x, this.pinNode("com"));
      const i =
        this.mode === "voltage" ? v * 1e-7 : this.mode === "current" ? v * 100 : (v - 1) * 1e-4;
      out[0] = i;
      out[1] = -i;
    } else if (this.comp.kind === "scope") {
      const g = nv(x, this.pinNode("gnd"));
      out[0] = (nv(x, this.pinNode("ch1")) - g) * 1e-6;
      out[1] = (nv(x, this.pinNode("ch2")) - g) * 1e-6;
      out[2] = -(out[0]! + out[1]!);
    } else {
      const g = nv(x, this.pinNode("gnd"));
      let sum = 0;
      for (let i = 0; i < 8; i++) {
        out[i] = (nv(x, this.pinNode(`d${i}`)) - g) * 1e-7;
        sum += out[i]!;
      }
      out[8] = -sum;
    }
    return out;
  }
  private reading(x: Float64Array): { value: number; overload: boolean } {
    const v = nv(x, this.pinNode("in")) - nv(x, this.pinNode("com"));
    switch (this.mode) {
      case "voltage":
        return { value: v, overload: false };
      case "current":
        return { value: v * 100, overload: false };
      default: {
        // 1 V behind 10 kΩ; R = Rref · v / (Vtest − v)
        if (v >= 0.995) return { value: Infinity, overload: true };
        return { value: Math.max(0, (10000 * v) / (1 - v)), overload: false };
      }
    }
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    if (ctx.dc) return;
    if (this.comp.kind === "dmm" && this.ac) {
      const r = this.reading(x).value;
      const decay = Math.exp(-ctx.dt / 0.1);
      this.st.n.ms = (this.st.n.ms ?? 0) * decay + r * r * ctx.dt;
      this.st.n.mw = (this.st.n.mw ?? 0) * decay + ctx.dt;
    } else if (this.comp.kind === "scope") {
      const tdiv = numParam(this.p, "tdiv", 1e-3);
      // ~4000 stored samples per screen; finer solver steps are folded into min/max envelopes
      const every = (tdiv * 10) / 4000;
      let buf = probes.get(this.comp.id);
      if (!buf) {
        buf = new ProbeBuffer(2, 65536);
        probes.set(this.comp.id, buf);
      }
      const g = nv(x, this.pinNode("gnd"));
      const v0 = nv(x, this.pinNode("ch1")) - g;
      const v1 = nv(x, this.pinNode("ch2")) - g;
      const n = this.st.n;
      n.lo0 = Math.min(n.lo0 ?? v0, v0);
      n.hi0 = Math.max(n.hi0 ?? v0, v0);
      n.lo1 = Math.min(n.lo1 ?? v1, v1);
      n.hi1 = Math.max(n.hi1 ?? v1, v1);
      if (ctx.t - buf.lastT >= every - 1e-15) {
        buf.push(ctx.t, [v0, v1], [n.lo0, n.lo1], [n.hi0, n.hi1]);
        n.lo0 = v0;
        n.hi0 = v0;
        n.lo1 = v1;
        n.hi1 = v1;
      }
    } else if (this.comp.kind === "logic_analyzer") {
      const tdiv = numParam(this.p, "tdiv", 1e-3);
      const every = Math.max(ctx.dt, (tdiv * 10) / 2000);
      let buf = probes.get(this.comp.id);
      if (!buf) {
        buf = new ProbeBuffer(8, 24000);
        probes.set(this.comp.id, buf);
      }
      if (ctx.t - buf.lastT >= every - 1e-15) {
        const g = nv(x, this.pinNode("gnd"));
        buf.push(
          ctx.t,
          Array.from({ length: 8 }, (_, i) => nv(x, this.pinNode(`d${i}`)) - g),
        );
      }
    }
  }
  override aux(x: Float64Array): Record<string, number> {
    if (this.comp.kind === "dmm") {
      const r = this.reading(x);
      if (this.ac) {
        const w = this.st.n.mw ?? 0;
        return { reading: w > 0 ? Math.sqrt((this.st.n.ms ?? 0) / w) : Math.abs(r.value), overload: 0 };
      }
      return { reading: r.value, overload: r.overload ? 1 : 0 };
    }
    if (this.comp.kind === "scope") {
      const g = nv(x, this.pinNode("gnd"));
      return { ch1: nv(x, this.pinNode("ch1")) - g, ch2: nv(x, this.pinNode("ch2")) - g };
    }
    return {};
  }
}

/** Parts that are drawn and wired but not simulated electrically in this build. */
export class NullDevice extends Device {
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.thermalGain = 0;
  }
  stamp(): void {
    /* no electrical behaviour */
  }
  pinCurrents(): number[] {
    return this.nodes.map(() => 0);
  }
}

export class GroundDevice extends NullDevice {}
