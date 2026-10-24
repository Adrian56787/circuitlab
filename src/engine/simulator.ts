import { CATALOG } from "@/models/catalog";
import { pinKey } from "@/models/types";
import type { ComponentSnapshot, FailureRecord, LogicLevel, PlacedComponent, SimSnapshot, Wire } from "@/models/types";
import { Device, DeviceState, type ProbeStore, type StepCtx } from "./devices";
import { createDevice } from "./factory";
import { Stamper, solveInPlace } from "./mna";
import { buildNetlist, type Netlist } from "./netlist";

const GMIN = 1e-12;
const MAX_NEWTON = 60;

export interface AdvanceResult {
  steps: number;
  simulated: number;
}

/**
 * Transient circuit simulator: backward-Euler companion models + Newton–Raphson,
 * solved with dense MNA. One instance lives for the lifetime of the app; call
 * `compile` whenever the circuit or any parameter changes — device state
 * (capacitor voltages, burned flags, latches) survives recompilation by component id.
 */
export class Simulator {
  time = 0;
  readonly probes: ProbeStore = new Map();

  private states = new Map<string, DeviceState>();
  private devices: Device[] = [];
  private netlist: Netlist = { nets: new Map(), pinNet: new Map(), groundNet: null };
  private nodeOfNet = new Map<string, number>();
  private wires: readonly Wire[] = [];
  private base = new Stamper(0, 0);
  private work = new Stamper(0, 0);
  private x = new Float64Array(0);
  private xNew = new Float64Array(0);
  private nonlinear = false;
  private messages: string[] = [];
  private autoGround = false;
  private singular = false;
  private converged = true;
  private iterations = 0;
  private burnedAnnounced = new Set<string>();
  private failureLog: FailureRecord[] = [];
  private components: readonly PlacedComponent[] = [];
  /** Emitted when a part is destroyed. */
  onBurn: ((comp: PlacedComponent, reason: string) => void) | null = null;

  compile(components: readonly PlacedComponent[], wires: readonly Wire[]): void {
    this.components = components;
    this.wires = wires;
    this.messages = [];
    this.autoGround = false;
    const valid = components.filter((c) => CATALOG.has(c.kind));
    const nl = buildNetlist(valid, wires);
    this.netlist = nl;

    // pick ground
    let groundNet = nl.groundNet;
    if (!groundNet && valid.length > 0) {
      const src = valid.find((c) => CATALOG.get(c.kind)!.sim === "vsource");
      const pinId = src ? CATALOG.get(src.kind)!.pins[1]!.id : null;
      const key = src && pinId ? pinKey({ componentId: src.id, pinId }) : null;
      groundNet = (key && nl.pinNet.get(key)) || nl.pinNet.values().next().value || null;
      if (groundNet) {
        this.autoGround = true;
        this.messages.push("No GND symbol found — using the first source's negative terminal as 0 V.");
      }
    }

    this.nodeOfNet = new Map();
    let n = 0;
    for (const id of nl.nets.keys()) {
      if (id === groundNet) this.nodeOfNet.set(id, -1);
      else this.nodeOfNet.set(id, n++);
    }

    // drop state for deleted components
    const alive = new Set(valid.map((c) => c.id));
    for (const id of [...this.states.keys()]) if (!alive.has(id)) this.states.delete(id);

    this.devices = [];
    let branchCount = 0;
    for (const c of valid) {
      const def = CATALOG.get(c.kind)!;
      let st = this.states.get(c.id);
      if (!st) {
        st = new DeviceState();
        this.states.set(c.id, st);
      }
      const nodes = def.pins.map((p) => {
        const net = nl.pinNet.get(pinKey({ componentId: c.id, pinId: p.id }))!;
        return this.nodeOfNet.get(net) ?? -1;
      });
      const dev = createDevice(c, def, nodes, st);
      dev.branchBase = branchCount;
      branchCount += dev.branches;
      dev.branchIndexAbs = n + dev.branchBase;
      this.devices.push(dev);
    }

    this.nonlinear = this.devices.some((d) => d.nonlinear);
    this.base = new Stamper(n, branchCount);
    this.work = new Stamper(n, branchCount);
    const size = n + branchCount;
    const prev = this.x;
    this.x = new Float64Array(size);
    this.x.set(prev.subarray(0, Math.min(prev.length, size)));
    this.xNew = new Float64Array(size);
    this.singular = false;
  }

  /** Replace a destroyed part with a fresh one (clears burn state and heat). */
  repair(id: string): void {
    this.states.set(id, new DeviceState());
    this.burnedAnnounced.delete(id);
    this.failureLog = this.failureLog.filter((f) => f.id !== id);
    this.compile(this.components, this.wires);
  }

  reset(): void {
    this.time = 0;
    this.states.clear();
    this.probes.clear();
    this.burnedAnnounced.clear();
    this.failureLog = [];
    this.x = new Float64Array(this.x.length);
    this.compile(this.components, this.wires);
  }

  /** Advance one step of length dt. Returns false if the matrix was singular. */
  step(dtWanted: number, dc = false): boolean {
    let dt = dtWanted;
    if (!dc) {
      // Land exactly on scheduled device events (MCU wake-ups, ultrasonic echo edges …).
      for (const d of this.devices) {
        const lim = d.maxStep(this.time);
        if (lim < dt) dt = Math.max(lim, 1e-9);
      }
    }
    this.lastDt = dc ? 0 : dt;
    const ctx: StepCtx = { t: this.time + dt, dt: dc ? 0 : dt, dc, srcScale: 1, homotopy: 1 };
    const size = this.base.size;
    if (size === 0) {
      this.time += dc ? 0 : dt;
      return true;
    }

    this.base.clear();
    for (const d of this.devices) d.stamp(this.base, ctx);
    for (let i = 0; i < this.base.nodeCount; i++) this.base.add(i, i, GMIN);

    let ok = true;
    if (!this.nonlinear) {
      this.work.copyFrom(this.base);
      ok = solveInPlace(this.work.A, this.work.b, size, this.xNew);
      this.iterations = 1;
      this.converged = true;
      if (ok) this.x.set(this.xNew);
    } else {
      const x0 = this.x.slice();
      let r = this.newton(ctx, size);
      if ((!r.ok || !r.converged) && this.devices.some((d) => d.nonlinear && (d as { stiff?: boolean }).stiff)) {
        // Continuation: ramp the stiff blocks' gain from the previous solution up to the real value.
        this.x.set(x0);
        for (const h of [0.2, 0.4, 0.6, 0.8, 1]) {
          r = this.newton({ ...ctx, homotopy: h }, size);
          if (!r.ok) break;
        }
      }
      ok = r.ok;
      this.iterations = r.iterations;
      this.converged = r.converged;
    }

    this.singular = !ok;
    if (!ok) {
      if (!this.messages.includes("Circuit is unsolvable (loop of ideal sources or no path to ground).")) {
        this.messages.push("Circuit is unsolvable (loop of ideal sources or no path to ground).");
      }
      this.x.fill(0);
      return false;
    }

    for (const d of this.devices) {
      d.accept(this.x, ctx, this.probes);
      if (d.st.burned && !this.burnedAnnounced.has(d.comp.id)) {
        this.burnedAnnounced.add(d.comp.id);
        const reason = d.st.cause || `${d.def.name} was destroyed by overload.`;
        this.failureLog.push({ id: d.comp.id, label: d.comp.label, name: d.def.name, time: this.time + dt, reason });
        this.messages.push(`${d.comp.label}: ${reason}`);
        this.onBurn?.(d.comp, reason);
      }
    }
    if (!dc) this.time += dt;
    return true;
  }

  /** One Newton–Raphson solve for the stamped base matrix; leaves the result in this.x. */
  private newton(ctx: StepCtx, size: number): { ok: boolean; converged: boolean; iterations: number } {
    let iter = 0;
    for (; iter < MAX_NEWTON; iter++) {
      this.work.copyFrom(this.base);
      let limited = false;
      for (const d of this.devices) if (d.nonlinear && d.stampNL(this.work, this.x, ctx)) limited = true;
      if (!solveInPlace(this.work.A, this.work.b, size, this.xNew)) return { ok: false, converged: false, iterations: iter };
      let maxErr = 0;
      for (let i = 0; i < size; i++) {
        const a = this.xNew[i]!;
        const b = this.x[i]!;
        if (!Number.isFinite(a)) return { ok: false, converged: false, iterations: iter };
        const tol = (i < this.base.nodeCount ? 1e-6 : 1e-9) + 1e-4 * Math.max(Math.abs(a), Math.abs(b));
        maxErr = Math.max(maxErr, Math.abs(a - b) / tol);
      }
      this.x.set(this.xNew);
      if (!limited && maxErr <= 1) return { ok: true, converged: true, iterations: iter + 1 };
    }
    return { ok: true, converged: false, iterations: iter };
  }

  /**
   * Advance `simSeconds` of circuit time using at most `maxSteps` solver steps and `budgetMs` of wall time.
   * The step size adapts so that fast frames never stall the UI.
   */
  advance(simSeconds: number, baseDt: number, maxSteps = 400, budgetMs = 10, hardDt = Infinity): AdvanceResult {
    if (simSeconds <= 0) return { steps: 0, simulated: 0 };
    const planned = Math.min(maxSteps, Math.max(1, Math.ceil(simSeconds / baseDt)));
    // `hardDt` is an accuracy / display ceiling (AC sources, scope time base): when the step budget cannot
    // cover the requested time at that resolution the simulation simply runs slower than requested.
    const dt = Math.min(simSeconds / planned, hardDt);
    const start = performance.now();
    const t0 = this.time;
    let done = 0;
    // Device events can shorten individual steps, so loop on simulated time rather than step count.
    while (this.time - t0 < simSeconds - 1e-12 && done < maxSteps * 4) {
      const remaining = simSeconds - (this.time - t0);
      if (!this.step(Math.min(dt, remaining))) {
        done++;
        break;
      }
      done++;
      if ((done & 3) === 0 && performance.now() - start > budgetMs) break;
    }
    return { steps: done, simulated: this.time - t0 };
  }

  /** Solve the DC operating point without advancing time (capacitors open, inductors shorted). */
  solveDC(): boolean {
    return this.step(1e-3, true);
  }

  // ───────────────────────── snapshot ─────────────────────────

  snapshot(): SimSnapshot {
    const ctx: StepCtx = { t: this.time, dt: this.lastDt, dc: this.lastDt === 0, srcScale: 1, homotopy: 1 };
    const netVoltage: Record<string, number> = {};
    for (const [id, node] of this.nodeOfNet) netVoltage[id] = node < 0 ? 0 : this.x[node] ?? 0;

    const pinNet: Record<string, string> = {};
    for (const [k, v] of this.netlist.pinNet) pinNet[k] = v;

    const components: Record<string, ComponentSnapshot> = {};
    const pinInto = new Map<string, number>();
    for (const d of this.devices) {
      const snap = d.report(this.x, ctx);
      components[d.comp.id] = snap;
      const cur = d.pinCurrents(this.x, ctx);
      d.def.pins.forEach((p, i) => pinInto.set(pinKey({ componentId: d.comp.id, pinId: p.id }), cur[i] ?? 0));
    }

    const wireNet: Record<string, string> = {};
    for (const w of this.wires) {
      const net = this.netlist.pinNet.get(pinKey(w.from));
      if (net) wireNet[w.id] = net;
    }

    return {
      time: this.time,
      netVoltage,
      pinNet,
      components,
      wireCurrent: this.wireCurrents(pinInto),
      logic: this.logicLevels(netVoltage),
      wireNet,
      burned: [...this.burnedAnnounced],
      failures: this.failureLog.filter((f) => this.components.some((c) => c.id === f.id)),
      diagnostics: {
        messages: this.messages.slice(-6),
        autoGround: this.autoGround,
        singular: this.singular,
        converged: this.converged,
        iterations: this.iterations,
      },
    };
  }

  /** Current electrical nets (valid after `compile`). */
  get nets(): Netlist {
    return this.netlist;
  }

  private lastDt = 1e-4;
  setLastDt(dt: number): void {
    this.lastDt = dt;
  }

  /**
   * Distribute the injected pin currents over a spanning tree of each wire network.
   * Edge flow = sum of the "into device" currents of everything on the far side of the edge.
   */
  private wireCurrents(pinInto: Map<string, number>): Record<string, number> {
    const adj = new Map<string, { wire: Wire; other: string }[]>();
    for (const w of this.wires) {
      const a = pinKey(w.from);
      const b = pinKey(w.to);
      if (!pinInto.has(a) || !pinInto.has(b)) continue;
      (adj.get(a) ?? adj.set(a, []).get(a)!).push({ wire: w, other: b });
      (adj.get(b) ?? adj.set(b, []).get(b)!).push({ wire: w, other: a });
    }
    const out: Record<string, number> = {};
    const seen = new Set<string>();
    for (const root of adj.keys()) {
      if (seen.has(root)) continue;
      // BFS order
      const order: string[] = [root];
      const parent = new Map<string, { via: Wire; from: string } | null>([[root, null]]);
      seen.add(root);
      for (let i = 0; i < order.length; i++) {
        const u = order[i]!;
        for (const { wire, other } of adj.get(u) ?? []) {
          if (parent.has(other)) continue;
          parent.set(other, { via: wire, from: u });
          seen.add(other);
          order.push(other);
        }
      }
      // accumulate subtree sums leaf → root
      const sum = new Map<string, number>();
      for (const k of order) sum.set(k, pinInto.get(k) ?? 0);
      for (let i = order.length - 1; i > 0; i--) {
        const k = order[i]!;
        const p = parent.get(k)!;
        const s = sum.get(k)!;
        // flow from parent into k equals s
        out[p.via.id] = pinKey(p.via.from) === p.from ? s : -s;
        sum.set(p.from, (sum.get(p.from) ?? 0) + s);
      }
    }
    for (const w of this.wires) if (!(w.id in out)) out[w.id] = 0;
    return out;
  }

  private logicLevels(netVoltage: Record<string, number>): Record<string, LogicLevel> {
    const out: Record<string, LogicLevel> = {};
    let vmax = 0;
    for (const v of Object.values(netVoltage)) vmax = Math.max(vmax, Math.abs(v));
    const ref = Math.max(1.8, vmax);
    for (const net of this.netlist.nets.values()) {
      if (!net.digital) continue;
      const driven = net.pins.some((key) => {
        const [cid, pid] = key.split(":") as [string, string];
        const comp = this.components.find((c) => c.id === cid);
        const pd = comp ? CATALOG.get(comp.kind)?.pins.find((q) => q.id === pid) : undefined;
        return !!pd && pd.kind !== "input" && pd.kind !== "analog";
      });
      const v = netVoltage[net.id] ?? 0;
      if (!driven) out[net.id] = "floating";
      else if (v > 0.6 * ref) out[net.id] = "high";
      else if (v < 0.3 * ref) out[net.id] = "low";
      else out[net.id] = "floating";
    }
    return out;
  }
}
