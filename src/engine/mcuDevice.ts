import { boardFor, type BoardSpec } from "@/mcu/boards";
import { compileSketch, type CompileResult } from "@/mcu/codegen";
import { getIo, type McuIo } from "@/mcu/io";
import { McuRuntime, type PinBus, type Program } from "@/mcu/runtime";
import { DEFAULT_SKETCH } from "@/mcu/templates";
import type { ComponentDef, ComponentSnapshot, PlacedComponent } from "@/models/types";
import {
  Device,
  G_OPEN,
  Junction,
  clamp,
  nv,
  type DeviceState,
  type Limit,
  type ProbeStore,
  type StepCtx,
} from "./devices";
import { lcdState, resetLcd } from "./lcdStore";
import type { Stamper } from "./mna";

// ───────────────────────── compiled-sketch cache ─────────────────────────

const compiled = new Map<string, CompileResult>();

export function compileCached(code: string, boardKind: string): CompileResult {
  const key = `${boardKind}\u0000${code}`;
  let r = compiled.get(key);
  if (!r) {
    r = compileSketch(code, boardKind);
    if (compiled.size > 64) compiled.clear();
    compiled.set(key, r);
  }
  return r;
}

interface Holder {
  hash: string;
  result: CompileResult;
  rt: McuRuntime | null;
}

const PULL = 35000;

interface Gpio {
  num: number;
  idx: number;
  node: number;
}

/** Microcontroller board: Thevenin GPIO drivers, supply logic and the sketch runtime. */
export class McuDevice extends Device implements PinBus {
  private readonly board: BoardSpec;
  private readonly holder: Holder;
  private readonly rt: McuRuntime | null;
  private readonly gpio: Gpio[] = [];
  private readonly gpioByNum = new Map<number, Gpio>();
  private readonly gnd: number;
  private readonly gndTies: number[] = [];
  private readonly usb: boolean;
  private xRef: Float64Array | null = null;
  /** per-pin-index driver captured at stamp time: [g, vt] */
  private drv = new Map<number, [number, number]>();
  private supply: { idx: number; g: number; vt: number }[] = [];
  private readonly io: McuIo;

  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.board = boardFor(comp.kind)!;
    this.io = getIo(comp.id);
    this.thermalGain = 4;
    this.usb = comp.params.usb !== false && comp.kind !== "attiny85";

    for (const [num, id] of this.board.pins) {
      const idx = def.pins.findIndex((p) => p.id === id);
      if (idx < 0) continue;
      const g = { num, idx, node: nodes[idx]! };
      this.gpio.push(g);
      this.gpioByNum.set(num, g);
    }
    const gndIdx = this.board.gndPins.map((id) => def.pins.findIndex((p) => p.id === id)).filter((i) => i >= 0);
    this.gnd = gndIdx.length ? nodes[gndIdx[0]!]! : -1;
    for (const i of gndIdx.slice(1)) this.gndTies.push(nodes[i]!);

    // compile (cached) and attach the persistent runtime
    const code = typeof comp.params.code === "string" ? comp.params.code : DEFAULT_SKETCH;
    const hash = `${comp.kind}\u0000${code}`;
    let holder = st.obj as Holder | null;
    if (!holder || holder.hash !== hash) {
      const result = compileCached(code, comp.kind);
      holder = { hash, result, rt: null };
      st.obj = holder;
      st.f.pw = false;
      resetLcd(comp.id);
      this.io.clear();
      if (!result.ok) {
        const e = result.errors[0]!;
        this.io.setStatus("error", `Line ${e.line}: ${e.message}`);
      } else {
        this.io.setStatus("idle");
      }
    }
    if (holder.result.ok && !holder.rt) {
      const js = holder.result.js;
      holder.rt = new McuRuntime((rt) => new Function("R", js)(rt) as Program, this.board, this.io);
    }
    this.holder = holder;
    this.rt = holder.rt;
    this.rt?.bind(this);
  }

  // ───────── PinBus

  volts(pin: number): number {
    const g = this.gpioByNum.get(pin);
    if (!g || !this.xRef) return 0;
    return nv(this.xRef, g.node) - nv(this.xRef, this.gnd);
  }
  vdd(): number {
    return this.st.n.vdd ?? this.board.vhigh;
  }

  // ───────── power

  private get powered(): boolean {
    return this.st.f.pw === true && !this.st.burned;
  }

  private idx(id: string): number {
    return this.def.pins.findIndex((p) => p.id === id);
  }

  // ───────── MNA

  stamp(s: Stamper): void {
    this.drv.clear();
    this.supply = [];
    if (this.st.burned) return;
    // tie ground pins together
    for (const n of this.gndTies) s.conductance(this.gnd, n, 1e3);

    const kind = this.board.kind;
    const vdd = this.vdd();
    if (kind === "arduino_uno") {
      if (this.usb || this.st.f.reg === true) {
        this.supply.push({ idx: this.idx("5v"), g: 1 / 0.3, vt: 5 });
        this.supply.push({ idx: this.idx("3v3"), g: 1 / 1, vt: 3.3 });
      }
    } else if (kind === "esp32") {
      if (this.usb || this.st.f.reg === true) this.supply.push({ idx: this.idx("3v3"), g: 1 / 0.3, vt: 3.3 });
    }
    for (const sp of this.supply) {
      if (sp.idx >= 0) s.branch(this.nodes[sp.idx]!, this.gnd, sp.g, -sp.g * sp.vt);
    }

    const rt = this.rt;
    for (const g of this.gpio) {
      const node = g.node;
      const p = this.powered && rt ? rt.pins.get(g.num) : undefined;
      if (p && p.mode === "out") {
        const gg = 1 / this.board.rout;
        const vt = p.drive ? vdd : 0;
        s.branch(node, this.gnd, gg, -gg * vt);
        this.drv.set(g.idx, [gg, vt]);
      } else if (p && p.level === 1 && !p.pulldown) {
        s.branch(node, this.gnd, 1 / PULL, -vdd / PULL);
        this.drv.set(g.idx, [1 / PULL, vdd]);
      } else if (p && p.pulldown) {
        s.conductance(node, this.gnd, 1 / PULL);
        this.drv.set(g.idx, [1 / PULL, 0]);
      } else {
        s.conductance(node, this.gnd, G_OPEN);
        this.drv.set(g.idx, [G_OPEN, 0]);
      }
    }
  }

  pinCurrents(x: Float64Array): number[] {
    const out = new Array<number>(this.def.pins.length).fill(0);
    if (this.st.burned) return out;
    const vg = nv(x, this.gnd);
    let sum = 0;
    for (const [idx, [g, vt]] of this.drv) {
      const i = g * (nv(x, this.nodes[idx]!) - vg - vt);
      out[idx] = i;
      sum += i;
    }
    for (const sp of this.supply) {
      if (sp.idx < 0) continue;
      const i = sp.g * (nv(x, this.nodes[sp.idx]!) - vg - sp.vt);
      out[sp.idx] = i;
      sum += i;
    }
    // ground pins carry the return current
    const gndIdx = this.board.gndPins.map((id) => this.idx(id)).filter((i) => i >= 0);
    for (const n of this.gndTies) {
      const k = this.nodes.indexOf(n);
      if (k < 0) continue;
      const i = 1e3 * (nv(x, n) - vg);
      out[k] = (out[k] ?? 0) + i;
      sum += i;
    }
    if (gndIdx.length) out[gndIdx[0]!] = (out[gndIdx[0]!] ?? 0) - sum - gndIdx.slice(1).reduce((a, k) => a + (out[k] ?? 0), 0);
    return out;
  }

  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    let worst = 0;
    const vg = nv(x, this.gnd);
    for (const [idx, [g, vt]] of this.drv) {
      const gpioPin = this.gpio.find((q) => q.idx === idx);
      if (!gpioPin) continue;
      worst = Math.max(worst, Math.abs(g * (nv(x, this.nodes[idx]!) - vg - vt)) / 0.04);
    }
    for (const sp of this.supply) {
      if (sp.idx >= 0) worst = Math.max(worst, Math.abs(sp.g * (nv(x, this.nodes[sp.idx]!) - vg - sp.vt)) / (sp.vt > 4 ? 0.5 : 0.15));
    }
    // over-voltage on supply / GPIO pins
    for (const g of this.gpio) {
      const v = nv(x, g.node) - vg;
      if (v > this.board.vhigh + 1.5 || v < -1.0) worst = Math.max(worst, Math.abs(v) / (this.board.vhigh + 1.5));
    }
    return worst;
  }

  /** Worst pin condition, described for the failure report. */
  protected override limits(x: Float64Array): Limit[] {
    const out: Limit[] = [];
    const vg = nv(x, this.gnd);
    for (const [idx, [g, vt]] of this.drv) {
      const gpioPin = this.gpio.find((q) => q.idx === idx);
      if (!gpioPin) continue;
      out.push({
        what: `current through pin ${gpioPin.num}`,
        actual: g * (nv(x, this.nodes[idx]!) - vg - vt),
        limit: 0.04,
        unit: "amp",
        hint: "A GPIO pin can only source/sink about 20–40 mA: use a series resistor, or drive heavy loads through a transistor.",
      });
    }
    for (const sp of this.supply) {
      if (sp.idx < 0) continue;
      out.push({
        what: "supply current",
        actual: sp.g * (nv(x, this.nodes[sp.idx]!) - vg - sp.vt),
        limit: sp.vt > 4 ? 0.5 : 0.15,
        unit: "amp",
        hint: "A supply pin is shorted or overloaded: check for a short between the supply and GND.",
      });
    }
    for (const g of this.gpio) {
      const v = nv(x, g.node) - vg;
      if (v > this.board.vhigh + 1.5 || v < -1.0) {
        out.push({
          what: `voltage on pin ${g.num}`,
          actual: v,
          limit: this.board.vhigh + 1.5,
          unit: "volt",
          hint: "Never drive a pin above the board's logic level (or below GND): use a divider or level shifter.",
        });
      }
    }
    return out;
  }

  override maxStep(t: number): number {
    if (!this.rt || !this.powered || this.rt.dead) return Infinity;
    const nt = this.rt.nextTime(t);
    return nt > t + 1e-12 ? nt - t : Infinity;
  }

  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    if (ctx.dc) return;
    this.xRef = x;
    const kind = this.board.kind;
    const vg = nv(x, this.gnd);
    let powered = false;
    let vdd = this.board.vhigh;
    if (this.st.burned) {
      powered = false;
    } else if (kind === "arduino_uno") {
      const v5 = nv(x, this.nodes[this.idx("5v")]!) - vg;
      const vin = nv(x, this.nodes[this.idx("vin")]!) - vg;
      if (this.usb) {
        powered = true;
      } else if (vin > 6.5) {
        this.st.f.reg = true;
        powered = true;
      } else {
        this.st.f.reg = false;
        powered = v5 > 3.0;
        vdd = clamp(v5, 0, 5.5);
      }
    } else if (kind === "esp32") {
      const v33 = nv(x, this.nodes[this.idx("3v3")]!) - vg;
      const vin = nv(x, this.nodes[this.idx("vin")]!) - vg;
      if (this.usb) powered = true;
      else if (vin > 4.5) {
        this.st.f.reg = true;
        powered = true;
      } else {
        this.st.f.reg = false;
        powered = v33 > 2.6;
        vdd = clamp(v33, 0, 3.6);
      }
    } else {
      const vcc = nv(x, this.nodes[this.idx("p8")]!) - nv(x, this.nodes[this.idx("p4")]!);
      powered = vcc > 2.0;
      vdd = clamp(vcc, 0, 6);
    }
    this.st.n.vdd = vdd;
    const was = this.st.f.pw === true;
    this.st.f.pw = powered;
    const rt = this.rt;
    if (!rt) return;
    if (powered && !was) rt.restart(ctx.t);
    else if (!powered && was) this.io.setStatus("off", "Unpowered");
    if (powered) rt.advance(ctx.t);
    if (powered && !rt.dead && this.io.status.kind === "idle") this.io.setStatus("running");
  }

  override aux(): Record<string, number> {
    return { running: this.powered && this.rt && !this.rt.dead ? 1 : 0, vdd: this.vdd() };
  }

  override report(x: Float64Array, ctx: StepCtx): ComponentSnapshot {
    const base = super.report(x, ctx);
    base.current = 0;
    for (const sp of this.supply) if (sp.idx >= 0) base.current += this.pinCurrents(x)[sp.idx] ?? 0;
    base.voltage = this.vdd();
    return base;
  }
}

// ───────────────────────── HD44780 LCD ─────────────────────────

/** Character LCD with a real HD44780 controller model: decodes RS/E/D4–D7 (or D0–D7) bus cycles. */
export class LcdDevice extends Device {
  private readonly backlight = new Junction(3.0, 2);
  private readonly pin: Record<string, number> = {};
  constructor(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState) {
    super(comp, def, nodes, st);
    this.nonlinear = true;
    for (const p of def.pins) this.pin[p.id] = nodes[def.pins.indexOf(p)]!;
    this.thermalGain = 6;
  }
  stamp(s: Stamper): void {
    if (this.st.burned) return;
    s.conductance(this.pin.vdd!, this.pin.vss!, 1 / 5000);
  }
  override stampNL(s: Stamper, x: Float64Array): boolean {
    if (this.st.burned) return false;
    const a = this.pin.a!;
    const k = this.pin.k!;
    const vnew = nv(x, a) - nv(x, k);
    const v = this.backlight.limit(vnew, this.st.n.vb ?? 0);
    const { i, g } = this.backlight.eval(v);
    s.branch(a, k, g, i - g * v);
    this.st.n.vb = v;
    return Math.abs(v - vnew) > 1e-9;
  }
  private blCurrent(x: Float64Array): number {
    return this.st.burned ? 0 : this.backlight.eval(nv(x, this.pin.a!) - nv(x, this.pin.k!)).i;
  }
  pinCurrents(x: Float64Array): number[] {
    const out = new Array<number>(this.def.pins.length).fill(0);
    if (this.st.burned) return out;
    const iv = (nv(x, this.pin.vdd!) - nv(x, this.pin.vss!)) / 5000;
    const ib = this.blCurrent(x);
    const set = (id: string, v: number): void => {
      const k = this.def.pins.findIndex((p) => p.id === id);
      if (k >= 0) out[k] = v;
    };
    set("vdd", iv);
    set("vss", -iv);
    set("a", ib);
    set("k", -ib);
    return out;
  }
  override stress(x: Float64Array): number {
    if (this.st.burned) return 0;
    const v = nv(x, this.pin.vdd!) - nv(x, this.pin.vss!);
    return Math.max(this.blCurrent(x) / 0.12, Math.abs(v) / 7);
  }
  protected override limits(x: Float64Array): Limit[] {
    return [
      { what: "backlight current", actual: this.blCurrent(x), limit: 0.12, unit: "amp", hint: "Feed the backlight (A/K) through a series resistor." },
      { what: "supply voltage", actual: nv(x, this.pin.vdd!) - nv(x, this.pin.vss!), limit: 7, unit: "volt", hint: "An HD44780 LCD runs from 5 V." },
    ];
  }

  private level(x: Float64Array, id: string, ref: number, vdd: number): number {
    const n = this.pin[id];
    if (n === undefined) return 0;
    return nv(x, n) - ref > vdd * 0.5 ? 1 : 0;
  }

  override accept(x: Float64Array, ctx: StepCtx, probes: ProbeStore): void {
    super.accept(x, ctx, probes);
    if (ctx.dc) return;
    const ref = nv(x, this.pin.vss!);
    const vdd = nv(x, this.pin.vdd!) - ref;
    const lcd = lcdState(this.comp.id);
    const powered = vdd > 3.0 && !this.st.burned;
    if (!powered) {
      if (this.st.f.pw) {
        // power loss clears the controller
        lcd.ddram.fill(32);
        lcd.on = false;
        lcd.initialised = false;
        this.st.n.bits = 8;
        this.st.n.nib = -1;
      }
      this.st.f.pw = false;
      this.st.f.e = false;
      return;
    }
    if (!this.st.f.pw) {
      this.st.f.pw = true;
      this.st.n.bits = 8;
      this.st.n.nib = -1;
      this.st.n.addr = 0;
      this.st.n.incr = 1;
      this.st.n.cg = 0;
      lcd.initialised = false;
    }
    const v0 = nv(x, this.pin.v0!) - ref;
    this.st.n.contrast = clamp(1 - v0 / (vdd * 0.7), 0, 1);

    const e = this.level(x, "e", ref, vdd) === 1;
    const wasE = this.st.f.e === true;
    this.st.f.e = e;
    if (!(wasE && !e)) return; // act on the falling edge of E
    const rs = this.level(x, "rs", ref, vdd);
    const d = (i: number): number => this.level(x, `d${i}`, ref, vdd) << i;
    const hi = d(4) | d(5) | d(6) | d(7);
    if ((this.st.n.bits ?? 8) === 8) {
      // 8-bit bus (also the power-on state): D0–D3 are read too (floating lines read low)
      this.process(lcd, rs, hi | d(0) | d(1) | d(2) | d(3));
    } else {
      const nib = this.st.n.nib ?? -1;
      if (nib < 0) this.st.n.nib = hi >> 4;
      else {
        this.st.n.nib = -1;
        this.process(lcd, rs, (nib << 4) | (hi >> 4));
      }
    }
  }

  private ddIndex(addr: number): number {
    if (addr < 0x28) return addr;
    if (addr >= 0x40 && addr < 0x68) return 40 + (addr - 0x40);
    return -1;
  }

  private process(lcd: ReturnType<typeof lcdState>, rs: number, byte: number): void {
    const bump = (): void => {
      this.st.n.addr = ((this.st.n.addr ?? 0) + ((this.st.n.incr ?? 1) ? 1 : -1)) & 0x7f;
      if (this.st.n.cg) this.st.n.addr &= 0x3f;
    };
    if (rs === 1) {
      lcd.initialised = true;
      if (this.st.n.cg) lcd.cgram[(this.st.n.addr ?? 0) & 63] = byte & 31;
      else {
        const i = this.ddIndex(this.st.n.addr ?? 0);
        if (i >= 0) lcd.ddram[i] = byte;
      }
      bump();
      if (this.st.n.shiftOnWrite) lcd.shift = (lcd.shift + ((this.st.n.incr ?? 1) ? 1 : -1) + 40) % 40;
      return;
    }
    if (byte & 0x80) {
      this.st.n.cg = 0;
      this.st.n.addr = byte & 0x7f;
    } else if (byte & 0x40) {
      this.st.n.cg = 1;
      this.st.n.addr = byte & 0x3f;
    } else if (byte & 0x20) {
      /* function set: 8/4 bit + lines — bus width changes are handled by the caller */
      if (!(byte & 0x10)) {
        this.st.n.bits = 4;
        this.st.n.nib = -1;
      }
    } else if (byte & 0x10) {
      // cursor / display shift
      const right = (byte & 0x04) !== 0;
      if (byte & 0x08) lcd.shift = (lcd.shift + (right ? -1 : 1) + 40) % 40;
      else this.st.n.addr = ((this.st.n.addr ?? 0) + (right ? 1 : -1)) & 0x7f;
    } else if (byte & 0x08) {
      lcd.on = (byte & 0x04) !== 0;
      lcd.cursorOn = (byte & 0x02) !== 0;
      lcd.blinkOn = (byte & 0x01) !== 0;
      lcd.initialised = true;
    } else if (byte & 0x04) {
      this.st.n.incr = byte & 0x02 ? 1 : 0;
      this.st.n.shiftOnWrite = byte & 0x01 ? 1 : 0;
    } else if (byte & 0x02) {
      this.st.n.addr = 0;
      this.st.n.cg = 0;
      lcd.shift = 0;
    } else if (byte & 0x01) {
      lcd.ddram.fill(32);
      this.st.n.addr = 0;
      this.st.n.cg = 0;
      this.st.n.incr = 1;
      lcd.shift = 0;
    }
    lcd.cursor = this.st.n.addr ?? 0;
  }

  override aux(): Record<string, number> {
    return { contrast: this.st.n.contrast ?? 0, powered: this.st.f.pw ? 1 : 0, backlight: clamp((this.st.n.vb ?? 0) > 2 ? 1 : 0, 0, 1) };
  }
  override report(x: Float64Array, ctx: StepCtx): ComponentSnapshot {
    const base = super.report(x, ctx);
    base.voltage = nv(x, this.pin.vdd!) - nv(x, this.pin.vss!);
    return base;
  }
}

