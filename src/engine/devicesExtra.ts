import type { ComponentDef, ComponentSnapshot, PlacedComponent } from "@/models/types";
import {
  BehaviouralDevice,
  Device,
  G_OPEN,
  GMIN,
  Junction,
  THETA,
  THETA_R,
  clamp,
  numParam,
  nv,
  type DeviceState,
  type ProbeStore,
  type StepCtx,
} from "./devices";
import type { Stamper } from "./mna";

// ───────────────────────── JFET (N-channel) ─────────────────────────

/** Shichman–Hodges JFET: square-law triode/saturation channel plus two gate junctions. */
export class JfetDevice extends BehaviouralDevice {
  private readonly idss: number;
  private readonly vp: number;
  private readonly lambda = 0.01;
  private readonly gate = new Junction(0.65, 1);
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.idss = Math.max(1e-6, numParam(comp.params, "idss", 0.01));
    this.vp = -Math.abs(numParam(comp.params, "vp", -3)) || -3;
    this.thermalGain = 6;
  }
  private channel(vgs: number, vds: number): number {
    const vov = vgs - this.vp;
    if (vov <= 0 || vds <= 0) return 0;
    const beta = this.idss / (this.vp * this.vp);
    if (vds < vov) return beta * vds * (2 * vov - vds) * (1 + this.lambda * vds);
    return beta * vov * vov * (1 + this.lambda * vds);
  }
  /** Drain→source channel current, symmetric under D/S exchange. */
  private ids(vg: number, vd: number, vs: number): number {
    if (vd >= vs) return this.channel(vg - vs, vd - vs);
    return -this.channel(vg - vd, vs - vd);
  }
  protected currents(v: number[]): number[] {
    const [vg, vd, vs] = v as [number, number, number];
    const ic = this.ids(vg, vd, vs);
    const igs = this.gate.eval(vg - vs).i;
    const igd = this.gate.eval(vg - vd).i;
    // pins: g, d, s — current INTO each
    return [igs + igd, ic - igd + GMIN * (vd - vs), -ic - igs - GMIN * (vd - vs)];
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    const [ig, id] = this.pinCurrents(x) as [number, number, number];
    const vds = nv(x, this.nodes[1]!) - nv(x, this.nodes[2]!);
    return Math.max(Math.abs(id * vds) / 0.35, Math.abs(ig) / 0.01, Math.abs(vds) / 40);
  }
  override report(x: Float64Array, ctx: StepCtx): ComponentSnapshot {
    const base = super.report(x, ctx);
    base.current = this.pinCurrents(x)[1]!;
    base.voltage = nv(x, this.nodes[1]!) - nv(x, this.nodes[2]!);
    return base;
  }
}

// ───────────────────────── SCR and triac ─────────────────────────

const R_ON = 0.05;
const V_ON = 1.0;

/** Latching thyristor: gate diode triggers it, it stays on until the current falls below holding. */
export class ScrDevice extends Device {
  private readonly gate = new Junction(0.8, 1.5);
  private readonly a: number;
  private readonly k: number;
  private readonly g: number;
  private readonly igt: number;
  private readonly ih: number;
  private readonly vdrm: number;
  private readonly imax: number;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.nonlinear = true;
    this.a = this.pinNode("a");
    this.k = this.pinNode("k");
    this.g = this.pinNode("g");
    this.igt = Math.max(1e-6, numParam(comp.params, "igt", 0.005));
    this.ih = Math.max(1e-4, numParam(comp.params, "holding", 0.003));
    this.vdrm = Math.max(10, numParam(comp.params, "vdrm", 400));
    this.imax = Math.max(0.1, numParam(comp.params, "maxCurrent", 5));
    this.thermalGain = 8;
  }
  private get on(): boolean {
    return this.st.f.on === true;
  }
  stamp(s: Stamper): void {
    if (this.st.burned) return;
    if (this.on) s.branch(this.a, this.k, 1 / R_ON, -V_ON / R_ON);
    else s.conductance(this.a, this.k, G_OPEN);
  }
  override stampNL(s: Stamper, x: Float64Array): boolean {
    if (this.st.burned) return false;
    const vnew = nv(x, this.g) - nv(x, this.k);
    const vold = this.st.n.vg ?? 0;
    const v = this.gate.limit(vnew, vold);
    const { i, g } = this.gate.eval(v);
    s.branch(this.g, this.k, g, i - g * v);
    this.st.n.vg = v;
    return Math.abs(v - vnew) > 1e-9;
  }
  private iak(x: Float64Array): number {
    if (this.st.burned) return 0;
    const v = nv(x, this.a) - nv(x, this.k);
    return this.on ? (v - V_ON) / R_ON : v * G_OPEN;
  }
  private igate(x: Float64Array): number {
    return this.st.burned ? 0 : this.gate.eval(nv(x, this.g) - nv(x, this.k)).i;
  }
  pinCurrents(x: Float64Array): number[] {
    const ia = this.iak(x);
    const ig = this.igate(x);
    return [ia, -ia - ig, ig];
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    const vak = nv(x, this.a) - nv(x, this.k);
    return Math.max(Math.abs(this.iak(x)) / this.imax, Math.abs(vak) / this.vdrm, this.igate(x) / 0.1);
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    if (ctx.dc || this.st.burned) return;
    const vak = nv(x, this.a) - nv(x, this.k);
    const ig = this.igate(x);
    if (!this.on) {
      if ((ig >= this.igt && vak > 0.5) || vak > this.vdrm) this.st.f.on = true;
    } else if (this.iak(x) < this.ih) {
      this.st.f.on = false;
    }
  }
  override aux(): Record<string, number> {
    return { on: this.on ? 1 : 0 };
  }
  override report(x: Float64Array, ctx: StepCtx): ComponentSnapshot {
    const base = super.report(x, ctx);
    base.voltage = nv(x, this.a) - nv(x, this.k);
    return base;
  }
}

/** Bidirectional thyristor: triggered by gate current of either polarity, conducts both ways. */
export class TriacDevice extends Device {
  private readonly pos = new Junction(0.9, 1.5);
  private readonly neg = new Junction(0.9, 1.5);
  private readonly m1: number;
  private readonly m2: number;
  private readonly g: number;
  private readonly igt: number;
  private readonly ih: number;
  private readonly vdrm: number;
  private readonly imax: number;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.nonlinear = true;
    this.m1 = this.pinNode("mt1");
    this.m2 = this.pinNode("mt2");
    this.g = this.pinNode("g");
    this.igt = Math.max(1e-6, numParam(comp.params, "igt", 0.01));
    this.ih = Math.max(1e-4, numParam(comp.params, "holding", 0.005));
    this.vdrm = Math.max(10, numParam(comp.params, "vdrm", 600));
    this.imax = Math.max(0.1, numParam(comp.params, "maxCurrent", 4));
    this.thermalGain = 8;
  }
  /** +1 / −1 = conducting with MT2 positive / negative; 0 = blocking. */
  private get dir(): number {
    return this.st.n.dir ?? 0;
  }
  stamp(s: Stamper): void {
    if (this.st.burned) return;
    const d = this.dir;
    if (d !== 0) s.branch(this.m2, this.m1, 1 / R_ON, (-d * V_ON) / R_ON);
    else s.conductance(this.m2, this.m1, G_OPEN);
  }
  override stampNL(s: Stamper, x: Float64Array): boolean {
    if (this.st.burned) return false;
    let limited = false;
    const legs: [Junction, number, number, string][] = [
      [this.pos, this.g, this.m1, "vp"],
      [this.neg, this.m1, this.g, "vn"],
    ];
    for (const [j, a, k, key] of legs) {
      const vnew = nv(x, a) - nv(x, k);
      const v = j.limit(vnew, this.st.n[key] ?? 0);
      const { i, g } = j.eval(v);
      s.branch(a, k, g, i - g * v);
      this.st.n[key] = v;
      if (Math.abs(v - vnew) > 1e-9) limited = true;
    }
    return limited;
  }
  private imt(x: Float64Array): number {
    if (this.st.burned) return 0;
    const v = nv(x, this.m2) - nv(x, this.m1);
    const d = this.dir;
    return d !== 0 ? (v - d * V_ON) / R_ON : v * G_OPEN;
  }
  private igate(x: Float64Array): number {
    if (this.st.burned) return 0;
    return this.pos.eval(nv(x, this.g) - nv(x, this.m1)).i - this.neg.eval(nv(x, this.m1) - nv(x, this.g)).i;
  }
  pinCurrents(x: Float64Array): number[] {
    const it = this.imt(x);
    const ig = this.igate(x);
    // catalog order: mt1, mt2, g
    return [-it - ig, it, ig];
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    const v = nv(x, this.m2) - nv(x, this.m1);
    return Math.max(Math.abs(this.imt(x)) / this.imax, Math.abs(v) / this.vdrm, Math.abs(this.igate(x)) / 0.2);
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    if (ctx.dc || this.st.burned) return;
    const v = nv(x, this.m2) - nv(x, this.m1);
    const d = this.dir;
    if (d === 0) {
      if ((Math.abs(this.igate(x)) >= this.igt && Math.abs(v) > 0.5) || Math.abs(v) > this.vdrm) {
        this.st.n.dir = v >= 0 ? 1 : -1;
      }
    } else if (d * this.imt(x) < this.ih) {
      this.st.n.dir = 0;
    }
  }
  override aux(): Record<string, number> {
    return { on: this.dir !== 0 ? 1 : 0 };
  }
  override report(x: Float64Array, ctx: StepCtx): ComponentSnapshot {
    const base = super.report(x, ctx);
    base.current = this.imt(x);
    base.voltage = nv(x, this.m2) - nv(x, this.m1);
    return base;
  }
}

// ───────────────────────── optocoupler ─────────────────────────

/** IR LED driving a phototransistor: Ic = CTR · If · tanh(Vce / 0.25). */
export class OptoDevice extends Device {
  private readonly led = new Junction(1.2, 2);
  private readonly a: number;
  private readonly k: number;
  private readonly c: number;
  private readonly e: number;
  private readonly ctr: number;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.nonlinear = true;
    this.a = this.pinNode("a");
    this.k = this.pinNode("k");
    this.c = this.pinNode("c");
    this.e = this.pinNode("e");
    this.ctr = Math.max(0.01, numParam(comp.params, "ctr", 100) / 100);
    this.thermalGain = 6;
  }
  stamp(s: Stamper): void {
    s.conductance(this.c, this.e, G_OPEN);
  }
  override stampNL(s: Stamper, x: Float64Array): boolean {
    if (this.st.burned) return false;
    const vnew = nv(x, this.a) - nv(x, this.k);
    const v = this.led.limit(vnew, this.st.n.vd ?? 0);
    const { i, g } = this.led.eval(v);
    s.branch(this.a, this.k, g, i - g * v);
    this.st.n.vd = v;

    const vceRaw = nv(x, this.c) - nv(x, this.e);
    // Limit the collector-voltage step so Newton can't leap over the sharp saturation knee.
    const vceOld = this.st.n.vce ?? vceRaw;
    const vce = vceOld + clamp(vceRaw - vceOld, -0.4, 0.4);
    this.st.n.vce = vce;
    const f = Math.tanh(vce / 0.25);
    const ifw = Math.max(0, i);
    const ic0 = this.ctr * ifw * f;
    const dIda = i > 0 ? this.ctr * g * f : 0;
    const dIdce = (this.ctr * ifw * (1 - f * f)) / 0.25 + GMIN;
    // Ic ≈ ic0 + dIda·(vak − v) + dIdce·(vce − vce0); flows c → e through the device.
    const cst = ic0 - dIda * v - dIdce * vce;
    s.add(this.c, this.a, dIda);
    s.add(this.c, this.k, -dIda);
    s.add(this.c, this.c, dIdce);
    s.add(this.c, this.e, -dIdce);
    s.rhs(this.c, -cst);
    s.add(this.e, this.a, -dIda);
    s.add(this.e, this.k, dIda);
    s.add(this.e, this.c, -dIdce);
    s.add(this.e, this.e, dIdce);
    s.rhs(this.e, cst);
    return Math.abs(v - vnew) > 1e-9 || Math.abs(vce - vceRaw) > 1e-9;
  }
  private currents(x: Float64Array): { ifw: number; ic: number; vce: number } {
    if (this.st.burned) return { ifw: 0, ic: 0, vce: 0 };
    const ifw = this.led.eval(nv(x, this.a) - nv(x, this.k)).i;
    const vce = nv(x, this.c) - nv(x, this.e);
    return { ifw, ic: this.ctr * Math.max(0, ifw) * Math.tanh(vce / 0.25) + vce * G_OPEN, vce };
  }
  pinCurrents(x: Float64Array): number[] {
    const { ifw, ic } = this.currents(x);
    return [ifw, -ifw, ic, -ic];
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    const { ifw, ic, vce } = this.currents(x);
    return Math.max(ifw / 0.06, Math.abs(ic) / 0.05, Math.abs(ic * vce) / 0.15, Math.abs(vce) / 80);
  }
  override aux(x: Float64Array): Record<string, number> {
    const { ifw, ic } = this.currents(x);
    return { if: ifw, ic };
  }
  override report(x: Float64Array, ctx: StepCtx): ComponentSnapshot {
    const base = super.report(x, ctx);
    base.voltage = nv(x, this.a) - nv(x, this.k);
    return base;
  }
}

// ───────────────────────── transformer ─────────────────────────

interface Winding {
  /** terminal pins (current is positive from a to b through the winding) */
  a: string;
  b: string;
  r: number;
}

/**
 * Coupled windings (two-winding transformer, or primary + two half-secondaries for the centre-tapped version),
 * solved with the θ-method. Every winding is a branch variable obeying
 *   V_k = R_k·i_k + Σ_j L_kj · di_j/dt,
 * so the secondary is galvanically isolated and magnetising current, leakage and winding loss all emerge from L and R.
 */
export class TransformerDevice extends Device {
  private readonly w: Winding[];
  private readonly L: number[][];
  private readonly iratedP: number;
  private readonly iratedS: number;
  private readonly ct: boolean;
  /** conductance across the primary representing iron (core) losses, specified as watts at 230 V */
  private readonly gCore: number;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.ct = comp.kind === "transformer_ct";
    this.gCore = Math.max(0, numParam(comp.params, "coreLoss", 1)) / (230 * 230);
    const ratio = Math.max(0.001, numParam(comp.params, "turnsRatio", 0.1));
    const lp = Math.max(1e-6, numParam(comp.params, "primaryInductance", 5));
    const k = clamp(numParam(comp.params, "coupling", 0.995), 0.5, 0.99999);
    const rp = Math.max(1e-3, numParam(comp.params, "primaryResistance", 5));
    this.iratedP = Math.max(0.01, numParam(comp.params, "ratedCurrent", 0.5));
    if (this.ct) {
      const h = ratio / 2; // each half winding
      const lh = lp * h * h;
      const m = k * Math.sqrt(lp * lh);
      const rh = Math.max(1e-4, rp * h * h);
      this.w = [
        { a: "p1", b: "p2", r: rp },
        { a: "s1", b: "sc", r: rh },
        { a: "sc", b: "s2", r: rh },
      ];
      this.L = [
        [lp, m, m],
        [m, lh, k * lh],
        [m, k * lh, lh],
      ];
      this.iratedS = this.iratedP / ratio;
    } else {
      const ls = lp * ratio * ratio;
      const m = k * Math.sqrt(lp * ls);
      this.w = [
        { a: "p1", b: "p2", r: rp },
        { a: "s1", b: "s2", r: Math.max(1e-4, rp * ratio * ratio) },
      ];
      this.L = [
        [lp, m],
        [m, ls],
      ];
      this.iratedS = this.iratedP / ratio;
    }
    this.branches = this.w.length;
    this.thermalGain = 3;
  }
  private i(w: number): number {
    return this.st.n[`i${w}`] ?? 0;
  }
  stamp(s: Stamper, ctx: StepCtx): void {
    const n = this.w.length;
    const row = (k: number): number => s.nodeCount + this.branchBase + k;
    if (this.st.burned) {
      // open-circuit every winding: branch currents forced to zero
      for (let k = 0; k < n; k++) s.add(row(k), row(k), 1);
      return;
    }
    if (this.gCore > 0) s.conductance(this.pinNode("p1"), this.pinNode("p2"), this.gCore);
    const kk = ctx.dc ? 0 : 1 / (THETA * ctx.dt);
    for (let a = 0; a < n; a++) {
      let hist = 0;
      for (let b = 0; b < n; b++) hist += this.L[a]![b]! * this.i(b);
      const vl = ctx.dc ? 0 : THETA_R * (this.st.n[`vl${a}`] ?? 0);
      s.voltageSource(this.branchBase + a, this.pinNode(this.w[a]!.a), this.pinNode(this.w[a]!.b), -kk * hist - vl);
      s.add(row(a), row(a), -(this.w[a]!.r + kk * this.L[a]![a]!));
      for (let b = 0; b < n; b++) if (b !== a) s.add(row(a), row(b), -kk * this.L[a]![b]!);
    }
  }
  private winding(x: Float64Array): number[] {
    if (this.st.burned) return this.w.map(() => 0);
    return this.w.map((_, k) => x[this.branchIndexAbs + k]!);
  }
  pinCurrents(x: Float64Array): number[] {
    const i = this.winding(x);
    const ic = this.st.burned ? 0 : this.gCore * (nv(x, this.pinNode("p1")) - nv(x, this.pinNode("p2")));
    const ip = i[0]! + ic;
    // catalog order: p1, p2, s1, s2   |   p1, p2, s1, sc, s2
    if (this.ct) return [ip, -ip, i[1]!, i[2]! - i[1]!, -i[2]!];
    return [ip, -ip, i[1]!, -i[1]!];
  }
  override stress(x: Float64Array): number {
    const i = this.winding(x);
    let s = Math.abs(i[0]!) / this.iratedP;
    for (let k = 1; k < i.length; k++) s = Math.max(s, Math.abs(i[k]!) / this.iratedS);
    return s;
  }
  private vSec(x: Float64Array): number {
    return this.ct
      ? nv(x, this.pinNode("s1")) - nv(x, this.pinNode("s2"))
      : nv(x, this.pinNode("s1")) - nv(x, this.pinNode("s2"));
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    const i = this.winding(x);
    for (let k = 0; k < this.w.length; k++) {
      this.st.n[`i${k}`] = i[k]!;
      const v = nv(x, this.pinNode(this.w[k]!.a)) - nv(x, this.pinNode(this.w[k]!.b));
      this.st.n[`vl${k}`] = ctx.dc ? 0 : v - this.w[k]!.r * i[k]!;
    }
    if (ctx.dc || this.st.burned) return;
    // true-RMS and power read-outs: exponential window of 0.1 s of circuit time
    const decay = Math.exp(-ctx.dt / 0.1);
    const n = this.st.n;
    const vp = nv(x, this.pinNode("p1")) - nv(x, this.pinNode("p2"));
    const vs = this.vSec(x);
    // secondary current delivered to the load: leaves the winding, i.e. −i (passive convention)
    const isec = this.ct ? -(i[1]! + i[2]!) / 2 : -i[1]!;
    const upd = (key: string, val: number): void => {
      n[key] = (n[key] ?? 0) * decay + val * ctx.dt;
    };
    upd("sVp", vp * vp);
    upd("sVs", vs * vs);
    upd("sIp", i[0]! * i[0]!);
    upd("sIs", isec * isec);
    upd("sPin", vp * (i[0]! + this.gCore * vp));
    upd("sPout", this.ct ? -(nv(x, this.pinNode("s1")) - nv(x, this.pinNode("sc"))) * i[1]! - (nv(x, this.pinNode("sc")) - nv(x, this.pinNode("s2"))) * i[2]! : -vs * i[1]!);
    n.sW = (n.sW ?? 0) * decay + ctx.dt;
  }
  override aux(x: Float64Array): Record<string, number> {
    const n = this.st.n;
    const w = n.sW ?? 0;
    const r = (k: string): number => (w > 0 ? Math.sqrt(Math.max(0, (n[k] ?? 0) / w)) : 0);
    const pin = w > 0 ? (n.sPin ?? 0) / w : 0;
    const pout = w > 0 ? (n.sPout ?? 0) / w : 0;
    return {
      vp: nv(x, this.pinNode("p1")) - nv(x, this.pinNode("p2")),
      vs: this.vSec(x),
      vpRms: r("sVp"),
      vsRms: r("sVs"),
      ipRms: r("sIp"),
      isRms: r("sIs"),
      pin,
      pout,
      eff: pin > 1e-6 ? Math.max(0, Math.min(1, pout / pin)) : 0,
    };
  }
  override report(x: Float64Array, ctx: StepCtx): ComponentSnapshot {
    const base = super.report(x, ctx);
    base.current = this.winding(x)[0]!;
    base.voltage = nv(x, this.pinNode("p1")) - nv(x, this.pinNode("p2"));
    return base;
  }
}

// ───────────────────────── servo ─────────────────────────

/** Hobby servo: reads 0.5–2.5 ms pulses on SIG, slews at 600 °/s, draws more current while moving. */
export class ServoDevice extends Device {
  private readonly gnd: number;
  private readonly vcc: number;
  private readonly sig: number;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.gnd = this.pinNode("gnd");
    this.vcc = this.pinNode("vcc");
    this.sig = this.pinNode("sig");
    this.thermalGain = 8;
  }
  private get moving(): boolean {
    return this.st.f.moving === true;
  }
  stamp(s: Stamper): void {
    if (this.st.burned) return;
    s.conductance(this.vcc, this.gnd, 1 / (this.moving ? 30 : 600));
    s.conductance(this.sig, this.gnd, 1e-7);
  }
  pinCurrents(x: Float64Array): number[] {
    if (this.st.burned) return [0, 0, 0];
    const v = nv(x, this.vcc) - nv(x, this.gnd);
    const i = v / (this.moving ? 30 : 600);
    // catalog order: gnd, vcc, sig
    return [-i - (nv(x, this.sig) - nv(x, this.gnd)) * 1e-7, i, (nv(x, this.sig) - nv(x, this.gnd)) * 1e-7];
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    return Math.abs(nv(x, this.vcc) - nv(x, this.gnd)) / 7.5;
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    if (ctx.dc || this.st.burned) return;
    const g = nv(x, this.gnd);
    const powered = nv(x, this.vcc) - g > 3.5;
    const hi = nv(x, this.sig) - g > 2;
    const wasHi = this.st.f.hi === true;
    if (hi && !wasHi) this.st.n.rise = ctx.t - ctx.dt;
    if (!hi && wasHi) {
      const w = ctx.t - ctx.dt - (this.st.n.rise ?? 0);
      if (w > 0.3e-3 && w < 3e-3) this.st.n.target = clamp(((w - 0.5e-3) / 2e-3) * 180, 0, 180);
    }
    this.st.f.hi = hi;
    const angle = this.st.n.angle ?? numParam(this.p, "angle", 90);
    const target = this.st.n.target ?? angle;
    if (powered) {
      const step = 600 * ctx.dt;
      const next = Math.abs(target - angle) <= step ? target : angle + Math.sign(target - angle) * step;
      this.st.f.moving = next !== target;
      this.st.n.angle = next;
    } else {
      this.st.f.moving = false;
      this.st.n.angle = angle;
    }
  }
  override aux(): Record<string, number> {
    return { angle: this.st.n.angle ?? numParam(this.p, "angle", 90), target: this.st.n.target ?? -1 };
  }
}

// ───────────────────────── HC-SR04 ─────────────────────────

const SOUND = 343; // m/s

/** Ultrasonic ranger: a ≥10 µs TRIG pulse starts an ECHO pulse of length 2·d/c. */
export class UltrasonicDevice extends Device {
  private readonly gnd: number;
  private readonly vcc: number;
  private readonly trig: number;
  private readonly echo: number;
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.gnd = this.pinNode("gnd");
    this.vcc = this.pinNode("vcc");
    this.trig = this.pinNode("trig");
    this.echo = this.pinNode("echo");
    this.thermalGain = 8;
  }
  stamp(s: Stamper): void {
    if (this.st.burned) return;
    s.conductance(this.vcc, this.gnd, 1 / 330);
    s.conductance(this.trig, this.gnd, 1e-7);
    const high = this.st.f.echo === true;
    const g = 1 / 100;
    s.branch(this.echo, this.gnd, g, high ? (-g * (this.st.n.vhi ?? 5)) : 0);
  }
  pinCurrents(x: Float64Array): number[] {
    if (this.st.burned) return [0, 0, 0, 0];
    const vc = nv(x, this.vcc) - nv(x, this.gnd);
    const high = this.st.f.echo === true;
    const ie = (nv(x, this.echo) - nv(x, this.gnd) - (high ? (this.st.n.vhi ?? 5) : 0)) / 100;
    const it = (nv(x, this.trig) - nv(x, this.gnd)) * 1e-7;
    // catalog order: vcc, trig, echo, gnd
    return [vc / 330, it, ie, -vc / 330 - it - ie];
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    return Math.abs(nv(x, this.vcc) - nv(x, this.gnd)) / 6;
  }
  override maxStep(t: number): number {
    const s = this.st.n.echoStart;
    const e = this.st.n.echoEnd;
    let best = Infinity;
    for (const b of [s, e]) if (b !== undefined && b > t + 1e-12) best = Math.min(best, b - t);
    return best;
  }
  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    if (ctx.dc || this.st.burned) return;
    const g = nv(x, this.gnd);
    const vcc = nv(x, this.vcc) - g;
    const powered = vcc > 4;
    this.st.n.vhi = Math.max(0, vcc);
    const hi = nv(x, this.trig) - g > 2;
    const wasHi = this.st.f.trigHi === true;
    if (hi && !wasHi) this.st.n.trigRise = ctx.t - ctx.dt;
    if (!hi && wasHi && powered) {
      const w = ctx.t - ctx.dt - (this.st.n.trigRise ?? 0);
      if (w >= 9e-6) {
        const d = clamp(numParam(this.p, "distanceCm", 50), 2, 400) / 100;
        const start = ctx.t + 250e-6;
        this.st.n.echoStart = start;
        this.st.n.echoEnd = start + (2 * d) / SOUND;
      }
    }
    this.st.f.trigHi = hi;
    const s = this.st.n.echoStart;
    const e = this.st.n.echoEnd;
    this.st.f.echo = powered && s !== undefined && e !== undefined && ctx.t >= s - 1e-12 && ctx.t < e - 1e-12;
  }
  override aux(): Record<string, number> {
    return { echo: this.st.f.echo ? 1 : 0 };
  }
}
