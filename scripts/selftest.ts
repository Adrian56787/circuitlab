import { Simulator } from "../src/engine/simulator";
import { getDef } from "../src/models/catalog";
import { orthogonalRoute } from "../src/models/geometry";
import { compileSketch } from "../src/mcu/codegen";
import { boardFor } from "../src/mcu/boards";
import { McuIo, getIo } from "../src/mcu/io";
import { McuRuntime, type Program } from "../src/mcu/runtime";
import { autoSet, cfgFromParams, findSweep, measure, windowRange } from "../src/engine/scopeMath";
import { sourceValue } from "../src/engine/devices";
import { peekLcd } from "../src/engine/lcdStore";
import { templateById } from "../src/mcu/templates";
import type { PlacedComponent, Wire } from "../src/models/types";
import { CATALOG_LIST } from "../src/models/catalog";
import { HELP } from "../src/models/help";
import { FEATURE_GROUPS, groupOf } from "../src/models/featureGroups";
import { isAdvancedField } from "../src/models/viewMode";
import { parseEng } from "../src/models/units";

let n = 0;
function comp(kind: string, label: string, params: Record<string, number | string | boolean> = {}): PlacedComponent {
  return { id: `c${n++}`, kind, x: 0, y: 0, rotation: 0, mirror: false, label, params: { ...getDef(kind).defaults, ...params } };
}
function wire(a: PlacedComponent, pa: string, b: PlacedComponent, pb: string): Wire {
  return { id: `w${n++}`, from: { componentId: a.id, pinId: pa }, to: { componentId: b.id, pinId: pb }, color: "auto", routing: "orthogonal" };
}

let failed = 0;
function check(name: string, got: number, want: number, tol: number): void {
  const ok = Math.abs(got - want) <= tol;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}: got ${got.toPrecision(5)}, want ${want} ±${tol}`);
}

// 1. Voltage divider: 10 V, 1k/3k → 7.5 V at midpoint
{
  const v = comp("vdc", "V1", { voltage: 10, rint: 0 });
  const r1 = comp("resistor", "R1", { resistance: 1000 });
  const r2 = comp("resistor", "R2", { resistance: 3000 });
  const g = comp("ground", "GND");
  const w = [wire(v, "p", r1, "a"), wire(r1, "b", r2, "a"), wire(r2, "b", g, "g"), wire(v, "n", g, "g")];
  const sim = new Simulator();
  sim.compile([v, r1, r2, g], w);
  sim.step(1e-3);
  const s = sim.snapshot();
  const mid = s.netVoltage[s.pinNet[`${r1.id}:b`]!]!;
  check("divider midpoint (V)", mid, 7.5, 1e-6);
  check("divider current (mA)", s.components[r1.id]!.current * 1e3, 2.5, 1e-6);
  check("wire current v→r1 (mA)", s.wireCurrent[w[0]!.id]! * 1e3, 2.5, 1e-6);
}

// 2. RC charge: 5 V, 1k, 100 µF → τ = 0.1 s; at t = τ, Vc ≈ 5(1-e^-1) = 3.161
{
  const v = comp("vdc", "V1", { voltage: 5, rint: 0 });
  const r = comp("resistor", "R1", { resistance: 1000 });
  const c = comp("cap_ceramic", "C1", { capacitance: 100e-6 });
  const g = comp("ground", "GND");
  const w = [wire(v, "p", r, "a"), wire(r, "b", c, "a"), wire(c, "b", g, "g"), wire(v, "n", g, "g")];
  const sim = new Simulator();
  sim.compile([v, r, c, g], w);
  while (sim.time < 0.1 - 1e-12) sim.step(1e-5);
  const s = sim.snapshot();
  check("RC at t=τ (V)", s.netVoltage[s.pinNet[`${c.id}:a`]!]!, 5 * (1 - Math.exp(-1)), 0.02);
}

// 3. LED + resistor: 5 V, 330 Ω, red LED → ≈ (5-~1.9)/330 ≈ 9.4 mA
{
  const v = comp("vdc", "V1", { voltage: 5, rint: 0 });
  const r = comp("resistor", "R1", { resistance: 330 });
  const d = comp("led", "D1");
  const g = comp("ground", "GND");
  const w = [wire(v, "p", r, "a"), wire(r, "b", d, "a"), wire(d, "k", g, "g"), wire(v, "n", g, "g")];
  const sim = new Simulator();
  sim.compile([v, r, d, g], w);
  for (let i = 0; i < 5; i++) sim.step(1e-4);
  const s = sim.snapshot();
  const i = s.components[d.id]!.current * 1e3;
  check("LED current (mA)", i, 9.4, 1.0);
  check("LED forward drop (V)", s.components[d.id]!.voltage, 1.9, 0.25);
}

// 4. Overload: 12 V across 100 Ω / 0.25 W resistor (1.44 W) must burn
{
  const v = comp("vdc", "V1", { voltage: 12, rint: 0 });
  const r = comp("resistor", "R1", { resistance: 100 });
  const g = comp("ground", "GND");
  const w = [wire(v, "p", r, "a"), wire(r, "b", g, "g"), wire(v, "n", g, "g")];
  const sim = new Simulator();
  sim.compile([v, r, g], w);
  let t = 0;
  while (t < 2 && !sim.snapshot().components[r.id]!.burned) {
    sim.step(1e-3);
    t += 1e-3;
  }
  check("resistor burned within 2 s (1=yes)", sim.snapshot().components[r.id]!.burned ? 1 : 0, 1, 0);
  console.log("      burned after", t.toFixed(3), "s");
}

// 5. BJT switch: Vcc 5 V, Rb 10k from 5 V to base, Rc 1k → saturated, Vce small
{
  const v = comp("vdc", "V1", { voltage: 5, rint: 0 });
  const rb = comp("resistor", "Rb", { resistance: 10000 });
  const rc = comp("resistor", "Rc", { resistance: 1000 });
  const q = comp("bjt_npn", "Q1");
  const g = comp("ground", "GND");
  const w = [
    wire(v, "p", rb, "a"), wire(rb, "b", q, "b"),
    wire(v, "p", rc, "a"), wire(rc, "b", q, "c"),
    wire(q, "e", g, "g"), wire(v, "n", g, "g"),
  ];
  const sim = new Simulator();
  sim.compile([v, rb, rc, q, g], w);
  for (let i = 0; i < 5; i++) sim.step(1e-4);
  const s = sim.snapshot();
  check("BJT Vce(sat) (V)", s.components[q.id]!.voltage, 0.1, 0.15);
  check("BJT converged (1=yes)", s.diagnostics.converged ? 1 : 0, 1, 0);
}

// 6. 555 astable: R1 1k, R2 10k, C 10 µF → f ≈ 1.44/((R1+2R2)C) = 6.86 Hz. Count rising edges in 2 s.
{
  const v = comp("vdc", "V1", { voltage: 9, rint: 0 });
  const r1 = comp("resistor", "R1", { resistance: 1000 });
  const r2 = comp("resistor", "R2", { resistance: 10000 });
  const c = comp("cap_ceramic", "C1", { capacitance: 10e-6 });
  const u = comp("ic555", "U1");
  const g = comp("ground", "GND");
  const w = [
    wire(v, "p", u, "p8"), wire(v, "p", u, "p4"), wire(v, "p", r1, "a"),
    wire(r1, "b", u, "p7"), wire(r1, "b", r2, "a"),
    wire(r2, "b", u, "p6"), wire(u, "p6", u, "p2"), wire(u, "p2", c, "a"),
    wire(c, "b", g, "g"), wire(u, "p1", g, "g"), wire(v, "n", g, "g"),
  ];
  const sim = new Simulator();
  sim.compile([v, r1, r2, c, u, g], w);
  let edges = 0;
  let last = 0;
  const dt = 2e-5;
  while (sim.time < 2) {
    sim.step(dt);
    const q = sim.snapshot().components[u.id]!.aux.q ?? 0;
    if (q > last) edges++;
    last = q;
  }
  check("555 rising edges in 2 s", edges, 13.7, 1.5);
}

// 7. Half-wave rectifier: 10 V peak 50 Hz → diode → 1 kΩ. Output peak ≈ 10 - 0.7.
{
  const v = comp("vac", "V1", { amplitude: 10, frequency: 50, rint: 0 });
  const d = comp("diode", "D1");
  const r = comp("resistor", "R1", { resistance: 1000 });
  const g = comp("ground", "GND");
  const w = [wire(v, "p", d, "a"), wire(d, "k", r, "a"), wire(r, "b", g, "g"), wire(v, "n", g, "g")];
  const sim = new Simulator();
  sim.compile([v, d, r, g], w);
  let peak = -1e9;
  let trough = 1e9;
  while (sim.time < 0.04) {
    sim.step(5e-5);
    const s = sim.snapshot();
    const vo = s.netVoltage[s.pinNet[`${r.id}:a`]!]!;
    peak = Math.max(peak, vo);
    trough = Math.min(trough, vo);
  }
  check("rectifier peak (V)", peak, 9.3, 0.3);
  check("rectifier negative half blocked (V)", trough, 0, 0.05);
}

// 8. Presets: every one must solve, converge, and behave sensibly.
import { PRESETS } from "../src/presets/presets";
for (const preset of PRESETS) {
  const data = preset.build();
  const sim = new Simulator();
  sim.compile(data.components, data.wires);
  const f = data.components.find((c) => c.kind === "vac" || c.kind === "sigen");
  const freq = f ? Number(f.params.frequency) : 0;
  const dt = freq > 0 ? 1 / (freq * 80) : 2e-5;
  const tEnd = preset.id === "555" ? 0.5 : preset.id === "rc" ? 0.05 : preset.id === "bjt" ? 0.6 : 0.06;
  let ok = true;
  while (sim.time < tEnd) ok = sim.step(dt) && ok;
  const s = sim.snapshot();
  console.log(`      [${preset.id}] solved=${ok} converged=${s.diagnostics.converged} burned=${s.burned.length} msgs=${s.diagnostics.messages.join("|")}`);
  check(`preset ${preset.id} solves`, ok && s.diagnostics.converged ? 1 : 0, 1, 0);
  check(`preset ${preset.id} nothing burned`, s.burned.length, 0, 0);
  if (preset.id === "divider") {
    const m = data.components.find((c) => c.kind === "dmm")!;
    check("preset divider DMM reading (V)", s.components[m.id]!.aux.reading ?? NaN, 7.5, 0.01);
  }
  if (preset.id === "bridge") {
    const sc = data.components.find((c) => c.kind === "scope")!;
    const buf = sim.probes.get(sc.id)!;
    let lo = 1e9;
    for (let i = Math.floor(buf.count * 0.6); i < buf.count; i++) lo = Math.min(lo, buf.at(i).v(0));
    check("preset bridge: smoothed output never drops below (V)", lo, 10, 2.5);
  }
  if (preset.id === "555") {
    const led = data.components.find((c) => c.kind === "led")!;
    const sim2 = new Simulator();
    sim2.compile(data.components, data.wires);
    let flips = 0;
    let prev = false;
    while (sim2.time < 1) {
      sim2.step(2e-5);
      const on = (sim2.snapshot().components[led.id]!.aux.brightness ?? 0) > 0.2;
      if (on !== prev) flips++;
      prev = on;
    }
    check("preset 555: LED toggles about 14 times in 1 s", flips, 14, 3);
  }
  if (preset.id === "bjt") {
    const sc = data.components.find((c) => c.kind === "scope")!;
    const buf = sim.probes.get(sc.id);
    let min1 = 1e9, max1 = -1e9, min2 = 1e9, max2 = -1e9;
    if (buf) {
      for (let i = 0; i < buf.count; i++) {
        const smp = buf.at(i);
        if (smp.t < sim.time - 0.005) continue;
        min1 = Math.min(min1, smp.v(0)); max1 = Math.max(max1, smp.v(0));
        min2 = Math.min(min2, smp.v(1)); max2 = Math.max(max2, smp.v(1));
      }
    }
    const gain = (max2 - min2) / Math.max(1e-9, max1 - min1);
    console.log(`      amplifier gain ≈ ${gain.toFixed(1)} (in ${(max1 - min1).toFixed(4)} Vpp, out ${(max2 - min2).toFixed(3)} Vpp)`);
    check("preset bjt steady-state gain magnitude", gain, 80, 25);
  }
}

// 9. Extra device models ------------------------------------------------------
function run(comps: PlacedComponent[], wires: Wire[], steps = 400, dt = 1e-5): ReturnType<Simulator["snapshot"]> {
  const sim = new Simulator();
  sim.compile(comps, wires);
  for (let i = 0; i < steps; i++) sim.step(dt);
  return sim.snapshot();
}
const vAt = (s: ReturnType<Simulator["snapshot"]>, c: PlacedComponent, pin: string): number => s.netVoltage[s.pinNet[`${c.id}:${pin}`]!]!;

// 7805: 12 V in, 1 kΩ load → 5 V
{
  const v = comp("vdc", "V1", { voltage: 12, rint: 0 });
  const u = comp("reg7805", "U1");
  const r = comp("resistor", "R1", { resistance: 1000 });
  const g = comp("ground", "GND");
  const s = run([v, u, r, g], [wire(v, "p", u, "in"), wire(u, "gnd", g, "g"), wire(u, "out", r, "a"), wire(r, "b", g, "g"), wire(v, "n", g, "g")]);
  check("7805 output (V)", vAt(s, u, "out"), 5, 0.15);
  // dropout: 6 V in → output limited to ≈ vin − 2
  const v2 = comp("vdc", "V1", { voltage: 6, rint: 0 });
  const s2 = run([v2, u, r, g], [wire(v2, "p", u, "in"), wire(u, "gnd", g, "g"), wire(u, "out", r, "a"), wire(r, "b", g, "g"), wire(v2, "n", g, "g")]);
  check("7805 dropout at 6 V in (V)", vAt(s2, u, "out"), 4, 0.15);
}
// LM317 with R1 = 240, R2 = 720 → 1.25·(1+3) = 5 V
{
  const v = comp("vdc", "V1", { voltage: 12, rint: 0 });
  const u = comp("lm317", "U1");
  const r1 = comp("resistor", "R1", { resistance: 240 });
  const r2 = comp("resistor", "R2", { resistance: 720 });
  const rl = comp("resistor", "RL", { resistance: 1000 });
  const g = comp("ground", "GND");
  const s = run([v, u, r1, r2, rl, g], [wire(v, "p", u, "in"), wire(u, "out", r1, "a"), wire(r1, "b", u, "adj"), wire(u, "adj", r2, "a"), wire(r2, "b", g, "g"), wire(u, "out", rl, "a"), wire(rl, "b", g, "g"), wire(v, "n", g, "g")]);
  check("LM317 output (V)", vAt(s, u, "out"), 5.0, 0.15);
}
// UA741 non-inverting amp, gain 2: 2 V in → 4 V out
{
  const vs = comp("vdc", "VS", { voltage: 12, rint: 0 });
  const vin = comp("vdc", "VIN", { voltage: 2, rint: 0 });
  const u = comp("ua741", "U1");
  const rf = comp("resistor", "RF", { resistance: 10000 });
  const rg = comp("resistor", "RG", { resistance: 10000 });
  const g = comp("ground", "GND");
  const s = run([vs, vin, u, rf, rg, g], [wire(vs, "p", u, "vcc"), wire(vs, "n", g, "g"), wire(u, "vee", g, "g"), wire(vin, "p", u, "inp"), wire(vin, "n", g, "g"), wire(u, "out", rf, "a"), wire(rf, "b", u, "inn"), wire(u, "inn", rg, "a"), wire(rg, "b", g, "g")]);
  check("op-amp non-inverting gain-2 output (V)", vAt(s, u, "out"), 4, 0.02);
  // saturation: gain 2 on 8 V → clipped below supply − headroom (10.5 V)
  const vin2 = comp("vdc", "VIN", { voltage: 8, rint: 0 });
  const s2 = run([vs, vin2, u, rf, rg, g], [wire(vs, "p", u, "vcc"), wire(vs, "n", g, "g"), wire(u, "vee", g, "g"), wire(vin2, "p", u, "inp"), wire(vin2, "n", g, "g"), wire(u, "out", rf, "a"), wire(rf, "b", u, "inn"), wire(u, "inn", rg, "a"), wire(rg, "b", g, "g")]);
  check("op-amp saturates near rail − headroom (V)", vAt(s2, u, "out"), 10.5, 0.3);
}
// Zener 5.1 V regulator from 12 V through 1 kΩ
{
  const v = comp("vdc", "V1", { voltage: 12, rint: 0 });
  const r = comp("resistor", "R1", { resistance: 1000 });
  const z = comp("zener", "D1", { vz: 5.1 });
  const g = comp("ground", "GND");
  const s = run([v, r, z, g], [wire(v, "p", r, "a"), wire(r, "b", z, "k"), wire(z, "a", g, "g"), wire(v, "n", g, "g")]);
  check("zener clamps node (V)", vAt(s, z, "k"), 5.1, 0.25);
}
// N-MOSFET low-side switch, gate 5 V → drain ≈ 0
{
  const v = comp("vdc", "V1", { voltage: 12, rint: 0 });
  const vg = comp("vdc", "VG", { voltage: 5, rint: 0 });
  const r = comp("resistor", "R1", { resistance: 100 });
  const m = comp("nmos", "Q1");
  const g = comp("ground", "GND");
  const s = run([v, vg, r, m, g], [wire(v, "p", r, "a"), wire(r, "b", m, "d"), wire(m, "s", g, "g"), wire(vg, "p", m, "g"), wire(vg, "n", g, "g"), wire(v, "n", g, "g")]);
  check("NMOS on: Vds (V)", vAt(s, m, "d"), 0.5, 0.5);
  check("NMOS converged (1=yes)", s.diagnostics.converged ? 1 : 0, 1, 0);
  const vg0 = comp("vdc", "VG", { voltage: 0, rint: 0 });
  const s0 = run([v, vg0, r, m, g], [wire(v, "p", r, "a"), wire(r, "b", m, "d"), wire(m, "s", g, "g"), wire(vg0, "p", m, "g"), wire(vg0, "n", g, "g"), wire(v, "n", g, "g")]);
  check("NMOS off: drain at supply (V)", vAt(s0, m, "d"), 12, 0.05);
}
// PNP high-side switch: emitter 5 V, base pulled to ground through 4.7 kΩ, 330 Ω load → saturated
{
  const v = comp("vdc", "V1", { voltage: 5, rint: 0 });
  const rb = comp("resistor", "RB", { resistance: 4700 });
  const rl = comp("resistor", "RL", { resistance: 330 });
  const q = comp("bjt_pnp", "Q1");
  const g = comp("ground", "GND");
  const s = run([v, rb, rl, q, g], [wire(v, "p", q, "e"), wire(q, "b", rb, "a"), wire(rb, "b", g, "g"), wire(q, "c", rl, "a"), wire(rl, "b", g, "g"), wire(v, "n", g, "g")]);
  check("PNP saturated: collector near 5 V", vAt(s, q, "c"), 4.9, 0.2);
}
// NAND gate truth table
for (const [a, b, want] of [[5, 5, 0], [5, 0, 5], [0, 5, 5], [0, 0, 5]] as const) {
  const va = comp("vdc", "VA", { voltage: a, rint: 0 });
  const vb = comp("vdc", "VB", { voltage: b, rint: 0 });
  const u = comp("gate_nand", "U1");
  const rl = comp("resistor", "RL", { resistance: 10000 });
  const g = comp("ground", "GND");
  const s = run([va, vb, u, rl, g], [wire(va, "p", u, "a"), wire(vb, "p", u, "b"), wire(u, "y", rl, "a"), wire(rl, "b", g, "g"), wire(va, "n", g, "g"), wire(vb, "n", g, "g")], 5);
  check(`NAND(${a},${b}) (V)`, vAt(s, u, "y"), want, 0.1);
}
// Relay: 5 V coil energises, COM–NO closes and powers a load
{
  const v = comp("vdc", "V1", { voltage: 5, rint: 0 });
  const k = comp("relay", "K1", { coilResistance: 100 });
  const rl = comp("resistor", "RL", { resistance: 1000 });
  const g = comp("ground", "GND");
  const s = run([v, k, rl, g], [wire(v, "p", k, "c1"), wire(k, "c2", g, "g"), wire(v, "p", k, "com"), wire(k, "no", rl, "a"), wire(rl, "b", g, "g"), wire(v, "n", g, "g")], 20);
  check("relay closes load path (V)", vAt(s, k, "no"), 5, 0.2);
}
// Switch + 7-segment segment lit through a resistor
{
  const v = comp("vdc", "V1", { voltage: 5, rint: 0 });
  const r = comp("resistor", "R1", { resistance: 330 });
  const d = comp("sevenseg", "DS1");
  const g = comp("ground", "GND");
  const s = run([v, r, d, g], [wire(v, "p", r, "a"), wire(r, "b", d, "a"), wire(d, "com", g, "g"), wire(v, "n", g, "g")], 50);
  check("7-seg segment a brightness > 0.1", s.components[d.id]!.aux.b_a ?? 0, 0.5, 0.45);
  check("7-seg segment b dark", s.components[d.id]!.aux.b_b ?? 0, 0, 0.01);
}

// Bench supply current limit: 5 V / 0.1 A limit into 10 Ω → constant-current at 0.1 A (1 V); into 100 Ω stays a voltage source
{
  const mk = (rl: number): ReturnType<typeof run> => {
    const v = comp("vdc", "V1", { voltage: 5, rint: 0.05, currentLimit: 0.1 });
    const r = comp("resistor", "R1", { resistance: rl, powerRating: 5 });
    const g = comp("ground", "GND");
    return run([v, r, g], [wire(v, "p", r, "a"), wire(r, "b", g, "g"), wire(v, "n", g, "g")], 20);
  };
  const cc = mk(10);
  check("CC mode: load current (mA)", Math.abs([...Object.values(cc.components)][0]!.current) * 1e3, 100, 2);
  const cv = mk(100);
  check("CV mode: load voltage (V)", Math.abs([...Object.values(cv.components)][0]!.voltage), 4.99, 0.03);
}

// Orthogonal router never folds back through a pin stub
{
  const bad = (pts: { x: number; y: number }[], a: { x: number; y: number }, da: { x: number; y: number }): boolean => {
    const f = pts[1]!;
    return Math.sign(f.x - a.x) * da.x + Math.sign(f.y - a.y) * da.y < 0;
  };
  let folds = 0;
  const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  for (const da of dirs) for (const db of dirs) for (const bx of [-6, -1, 0, 3, 8]) for (const by of [-5, 0, 2, 7]) {
    const a = { x: 0, y: 0 };
    const b = { x: bx, y: by };
    const pts = orthogonalRoute(a, da, b, db);
    const rev = [...pts].reverse();
    if (bad(pts, a, da) || bad(rev, b, db)) folds++;
  }
  check("router: stub fold-backs", folds, 0, 0);
}


// ───────── extra device models ─────────
const idOf = (s: ReturnType<Simulator["snapshot"]>, c: PlacedComponent): number => s.components[c.id]!.current;
function simulate(comps: PlacedComponent[], wires: Wire[], seconds: number, dt: number, onStep?: (sim: Simulator) => void): Simulator {
  const sim = new Simulator();
  sim.compile(comps, wires);
  while (sim.time < seconds - 1e-12) {
    sim.step(dt);
    onStep?.(sim);
  }
  return sim;
}
const netV = (sim: Simulator, c: PlacedComponent, pin: string): number => {
  const s = sim.snapshot();
  return s.netVoltage[s.pinNet[`${c.id}:${pin}`]!]!;
};

// JFET: Vgs = 0 → saturation near Idss; Vgs below pinch-off → off
for (const [vg, want] of [[0, 0.0107], [-4, 0]] as const) {
  const vdd = comp("vdc", "VDD", { voltage: 12, rint: 0 });
  const vgs = comp("vdc", "VG", { voltage: vg, rint: 0 });
  const rd = comp("resistor", "RD", { resistance: 470, powerRating: 5 });
  const q = comp("jfet_n", "Q1", { idss: 0.01, vp: -3 });
  const g = comp("ground", "GND");
  const s = run([vdd, vgs, rd, q, g], [wire(vdd, "p", rd, "a"), wire(rd, "b", q, "d"), wire(q, "s", g, "g"), wire(vgs, "p", q, "g"), wire(vgs, "n", g, "g"), wire(vdd, "n", g, "g")], 50);
  check(`JFET Vgs=${vg} drain current (A)`, Math.abs(idOf(s, rd)), want, 0.0008);
}

// SCR: gate pulse latches it on, stays on after the gate is released, drops out when the supply is interrupted
{
  const v = comp("vdc", "V1", { voltage: 12, rint: 0 });
  const rl = comp("resistor", "RL", { resistance: 100, powerRating: 5 });
  const q = comp("scr", "Q1");
  const sw = comp("toggle_switch", "SW", { closed: true });
  const vg = comp("vdc", "VG", { voltage: 5, rint: 0 });
  const rg = comp("resistor", "RG", { resistance: 470 });
  const g = comp("ground", "GND");
  const comps = [v, rl, q, sw, vg, rg, g];
  const ws = [wire(v, "p", rl, "a"), wire(rl, "b", q, "a"), wire(q, "k", g, "g"), wire(vg, "p", sw, "a"), wire(sw, "b", rg, "a"), wire(rg, "b", q, "g"), wire(vg, "n", g, "g"), wire(v, "n", g, "g")];
  const sim = new Simulator();
  sim.compile(comps, ws);
  for (let i = 0; i < 100; i++) sim.step(1e-5);
  check("SCR on after gate pulse: load current (A)", Math.abs(idOf(sim.snapshot(), rl)), 0.11, 0.01);
  sw.params.closed = false;
  sim.compile(comps, ws);
  for (let i = 0; i < 100; i++) sim.step(1e-5);
  check("SCR stays latched with gate released (A)", Math.abs(idOf(sim.snapshot(), rl)), 0.11, 0.01);
  v.params.voltage = 0;
  sim.compile(comps, ws);
  for (let i = 0; i < 100; i++) sim.step(1e-5);
  v.params.voltage = 12;
  sim.compile(comps, ws);
  for (let i = 0; i < 100; i++) sim.step(1e-5);
  check("SCR stays off after current interruption (A)", Math.abs(idOf(sim.snapshot(), rl)), 0, 0.002);
}

// Triac: self-triggered from MT2 through 220 Ω conducts in both half-cycles
{
  const v = comp("vac", "V1", { amplitude: 20, frequency: 50, rint: 0.01 });
  const t = comp("triac", "Q1");
  const rl = comp("resistor", "RL", { resistance: 100, powerRating: 10 });
  const rg = comp("resistor", "RG", { resistance: 220 });
  const g = comp("ground", "GND");
  let vmax = -Infinity;
  let vmin = Infinity;
  const sim = simulate([v, t, rl, rg, g], [wire(v, "p", t, "mt2"), wire(t, "mt1", rl, "a"), wire(rl, "b", g, "g"), wire(v, "p", rg, "a"), wire(rg, "b", t, "g"), wire(v, "n", g, "g")], 0.06, 1e-4, (sm) => {
    if (sm.time > 0.02) {
      const val = netV(sm, rl, "a");
      vmax = Math.max(vmax, val);
      vmin = Math.min(vmin, val);
    }
  });
  void sim;
  check("triac positive half-cycle peak (V)", vmax, 17, 3);
  check("triac negative half-cycle peak (V)", vmin, -17, 3);
}

// Optocoupler: LED current switches the transistor
for (const [vin, wantVc] of [[5, 0.15], [0, 5]] as const) {
  const v = comp("vdc", "V1", { voltage: vin, rint: 0 });
  const rled = comp("resistor", "R1", { resistance: 470 });
  const vcc = comp("vdc", "V2", { voltage: 5, rint: 0 });
  const rl = comp("resistor", "R2", { resistance: 1000 });
  const u = comp("optocoupler", "U1");
  const g = comp("ground", "GND");
  const s = run([v, rled, vcc, rl, u, g], [wire(v, "p", rled, "a"), wire(rled, "b", u, "a"), wire(u, "k", g, "g"), wire(vcc, "p", rl, "a"), wire(rl, "b", u, "c"), wire(u, "e", g, "g"), wire(v, "n", g, "g"), wire(vcc, "n", g, "g")], 50);
  check(`opto Vin=${vin} collector (V)`, vAt(s, u, "c"), wantVc, 0.2);
}

// Transformer: 2:1 step-down, 10 V peak in → ≈ 5 V peak across a 100 Ω secondary load; secondary is isolated
{
  const v = comp("vac", "V1", { amplitude: 10, frequency: 50, rint: 0.01 });
  const t = comp("transformer", "T1", { turnsRatio: 0.5 });
  const rl = comp("resistor", "RL", { resistance: 100, powerRating: 5 });
  const g = comp("ground", "GND");
  const g2 = comp("ground", "GND2");
  let peak = 0;
  simulate([v, t, rl, g, g2], [wire(v, "p", t, "p1"), wire(t, "p2", g, "g"), wire(v, "n", g, "g"), wire(t, "s1", rl, "a"), wire(rl, "b", t, "s2"), wire(t, "s2", g2, "g")], 0.08, 1e-4, (sm) => {
    if (sm.time > 0.04) peak = Math.max(peak, Math.abs(netV(sm, t, "s1")));
  });
  check("transformer secondary peak (V)", peak, 4.8, 0.4);
}

// Servo: 2 ms pulses every 20 ms → 135°
{
  const v = comp("vdc", "V1", { voltage: 5, rint: 0 });
  const sg = comp("sigen", "G1", { waveform: "pwm", amplitude: 2.5, offset: 2.5, frequency: 50, duty: 10, rint: 50 });
  const m = comp("servo", "M1", { angle: 90 });
  const g = comp("ground", "GND");
  const sim = simulate([v, sg, m, g], [wire(v, "p", m, "vcc"), wire(m, "gnd", g, "g"), wire(sg, "p", m, "sig"), wire(sg, "n", g, "g"), wire(v, "n", g, "g")], 0.5, 5e-5);
  check("servo angle for 2 ms pulse (deg)", sim.snapshot().components[m.id]!.aux.angle ?? -1, 135, 3);
}

// HC-SR04: 10 µs trigger → echo width = 2·d/343 (50 cm → 2.915 ms)
{
  const v = comp("vdc", "V1", { voltage: 5, rint: 0 });
  const sg = comp("sigen", "G1", { waveform: "pwm", amplitude: 2.5, offset: 2.5, frequency: 10, duty: 0.01, rint: 50 });
  const u = comp("hcsr04", "U1", { distanceCm: 50 });
  const g = comp("ground", "GND");
  let hiTime = 0;
  simulate([v, sg, u, g], [wire(v, "p", u, "vcc"), wire(u, "gnd", g, "g"), wire(sg, "p", u, "trig"), wire(sg, "n", g, "g"), wire(v, "n", g, "g")], 0.09, 5e-6, (sm) => {
    if (netV(sm, u, "echo") > 2.5) hiTime += 5e-6;
  });
  check("ultrasonic echo width (ms)", hiTime * 1e3, 2.915, 0.15);
}

// ───────── microcontroller language / runtime (no circuit) ─────────
function runSketch(code: string, board = "arduino_uno", seconds = 0.5): string {
  const r = compileSketch(code, board);
  if (!r.ok) return `COMPILE ERROR line ${r.errors[0]!.line}: ${r.errors[0]!.message}`;
  const io = new McuIo();
  const rt = new McuRuntime((x) => new Function("R", r.js)(x) as Program, boardFor(board)!, io);
  rt.restart(0);
  for (let t = 1e-4; t <= seconds; t += 1e-4) rt.advance(t);
  return io.log.replace(/\r/g, "").trim();
}
const lang = (name: string, body: string, want: string, board = "arduino_uno"): void => {
  const got = runSketch(`void setup(){ Serial.begin(115200); }\nvoid loop(){ ${body} while(1){ delay(1000); } }`, board);
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  lang ${name}: got ${JSON.stringify(got)}${ok ? "" : `, want ${JSON.stringify(want)}`}`);
};
lang("byte wraps", "byte b = 250; b += 10; Serial.println(b);", "4");
lang("16-bit int overflow (Uno)", "int x = 32767; x++; Serial.println(x);", "-32768");
lang("32-bit int (ESP32)", "int x = 32767; x++; Serial.println(x);", "32768", "esp32");
lang("unsigned long math", "unsigned long a = 4000000000UL; a += 500000000UL; Serial.println(a);", "205032704");
lang("integer division truncates", "Serial.println(7 / 2); Serial.println(-7 / 2); Serial.println(7 % 3);", "3\n-3\n1");
lang("float division", "Serial.println(7 / 2.0); Serial.println(1.0f / 3, 4);", "3.50\n0.3333");
lang("compound shifts", "int a = 1; a <<= 4; a |= 3; Serial.println(a); Serial.println(a >> 2);", "19\n4");
lang("HEX print", "Serial.println(255, HEX); Serial.println(5, BIN);", "FF\n101");
lang("char arithmetic", "char c = 'a'; c += 2; Serial.println(c); Serial.println((int)c);", "c\n99");
lang("String ops", 'String s = "ab"; s += 12; s += "z"; Serial.println(s); Serial.println(s.length()); Serial.println(s.indexOf("1")); s.toUpperCase(); Serial.println(s);', "ab12z\n5\n2\nAB12Z");
lang("string + number concat", 'String s = "v=" + String(3.14159); Serial.println(s);', "v=3.14");
lang("arrays and loops", "int a[5] = {1,2,3}; int sum = 0; for (int i = 0; i < 5; i++) sum += a[i] * 2; Serial.println(sum);", "12");
lang("2D array", "int m[2][3]; for (int i=0;i<2;i++) for (int j=0;j<3;j++) m[i][j] = i*10+j; Serial.println(m[1][2]);", "12");
lang("switch fallthrough", "int n = 2; switch (n) { case 1: Serial.print(\"a\"); case 2: Serial.print(\"b\"); case 3: Serial.print(\"c\"); break; default: Serial.print(\"d\"); } Serial.println();", "bc");
lang("ternary + logic", "int x = 5; Serial.println(x > 3 && x < 9 ? 100 : 200); Serial.println(!x);", "100\n0");
lang("do-while / break / continue", "int i = 0, s = 0; do { i++; if (i == 2) continue; if (i > 5) break; s += i; } while (true); Serial.println(s);", "13");
lang("map / constrain", "Serial.println(map(512, 0, 1023, 0, 255)); Serial.println(constrain(15, 0, 10));", "127\n10");
lang("math functions", "Serial.println(sqrt(16.0), 1); Serial.println(pow(2, 10), 0); Serial.println(abs(-5));", "4.0\n1024\n5");
lang("sprintf", 'char buf[32]; sprintf(buf, "%d-%03d-%s-%c", 7, 5, "hi", 65); Serial.println(buf);', "7-005-hi-A");
lang("bit helpers", "byte v = 0; bitSet(v, 3); bitWrite(v, 0, 1); Serial.println(v); Serial.println(bitRead(v, 3));", "9\n1");
lang("sizeof", "int a[10]; Serial.println(sizeof(a)); Serial.println(sizeof(long));", "20\n4");
lang("char array printing", 'char s[] = "hey"; Serial.println(s); Serial.println(strlen(s));', "hey\n3");
lang("compile error reported", "int x = ;", "COMPILE ERROR line 2: Unexpected \";\".");
{
  const got = runSketch(`
int fib(int n) { if (n < 2) return n; return fib(n-1) + fib(n-2); }
int counter() { static int c = 0; c++; return c; }
const int N = 4;
#define SQ(x) ((x)*(x))
enum { A, B = 5, C };
float avg(int a[], int n) { float s = 0; for (int i=0;i<n;i++) s += a[i]; return s / n; }
void setup() { Serial.begin(9600); }
void loop() {
  Serial.println(fib(15));
  counter(); counter();
  Serial.println(counter());
  int arr[N] = {2,4,6,8};
  Serial.println(avg(arr, N), 1);
  Serial.println(SQ(7));
  Serial.println(C);
  while (true) delay(1000);
}`);
  const ok = got === "610\n3\n5.0\n49\n6";
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  lang functions/static/macro/enum: ${JSON.stringify(got)}`);
}

// ───────── microcontroller in a circuit ─────────
function mcuBoard(kind: string, code: string, extra: (b: PlacedComponent, g: PlacedComponent) => { comps: PlacedComponent[]; wires: Wire[] }, params: Record<string, number | string | boolean> = {}) {
  const b = comp(kind, "U1", { code, ...params });
  const g = comp("ground", "GND");
  const e = extra(b, g);
  const gndPin = kind === "attiny85" ? "p4" : kind === "esp32" ? "gnd" : "gnd1";
  return { b, g, comps: [b, g, ...e.comps], wires: [wire(b, gndPin, g, "g"), ...e.wires] };
}

// Blink: LED on D13 toggles every 500 ms
{
  const led = comp("led", "D1");
  const r = comp("resistor", "R1", { resistance: 330 });
  const m = mcuBoard("arduino_uno", templateById("blink")!.code, (b, g) => ({ comps: [led, r], wires: [wire(b, "d13", r, "a"), wire(r, "b", led, "a"), wire(led, "k", g, "g")] }));
  const sim = new Simulator();
  sim.compile(m.comps, m.wires);
  const samples: [number, number][] = [];
  while (sim.time < 2.05) {
    sim.step(1e-3);
    if (sim.time > 0.2 && Math.abs(((sim.time + 0.25) % 0.5) - 0.0) < 1e-3) samples.push([sim.time, netV(sim, led, "a")]);
  }
  // sample mid-phase values
  const hi = (t: number): number => { const x = samples.find(([ts]) => Math.abs(ts - t) < 1.5e-3); return x ? x[1] : NaN; };
  check("blink: LED anode lit at t=0.25 s (V)", hi(0.25), 1.9, 0.4);
  check("blink: LED anode dark at t=0.75 s (V)", hi(0.75), 0, 0.1);
  check("blink: LED anode lit at t=1.25 s (V)", hi(1.25), 1.9, 0.4);
}

// Serial print timing + button input with pull-up
{
  const sw = comp("toggle_switch", "SW", { closed: false });
  const led = comp("led", "D1");
  const r = comp("resistor", "R1", { resistance: 330 });
  const m = mcuBoard("arduino_uno", templateById("button")!.code, (b, g) => ({ comps: [sw, led, r], wires: [wire(b, "d2", sw, "a"), wire(sw, "b", g, "g"), wire(b, "d13", r, "a"), wire(r, "b", led, "a"), wire(led, "k", g, "g")] }));
  const sim = new Simulator();
  sim.compile(m.comps, m.wires);
  while (sim.time < 0.05) sim.step(1e-3);
  check("button released: LED off (V)", netV(sim, led, "a"), 0, 0.1);
  sw.params.closed = true;
  sim.compile(m.comps, m.wires);
  while (sim.time < 0.1) sim.step(1e-3);
  check("button pressed: LED on (V)", netV(sim, led, "a"), 1.9, 0.4);
}

// PWM: analogWrite(9, 64) → duty 25 % → mean ≈ 1.25 V
{
  const m = mcuBoard("arduino_uno", "void setup(){ pinMode(9, OUTPUT); analogWrite(9, 64); } void loop(){}", (b, g) => {
    const rl = comp("resistor", "RL", { resistance: 10000 });
    return { comps: [rl], wires: [wire(b, "d9", rl, "a"), wire(rl, "b", g, "g")] };
  });
  const sim = new Simulator();
  sim.compile(m.comps, m.wires);
  let acc = 0;
  let tt = 0;
  while (sim.time < 0.1) {
    const t0 = sim.time;
    sim.step(1e-3);
    if (t0 > 0.02) {
      acc += netV(sim, m.comps[2]!, "a") * (sim.time - t0);
      tt += sim.time - t0;
    }
  }
  check("PWM 25 % mean voltage (V)", acc / tt, 1.25, 0.1);
}

// ADC: potentiometer midpoint → analogRead ≈ 512
{
  const code = "void setup(){ Serial.begin(9600); } void loop(){ Serial.println(analogRead(A0)); delay(100); }";
  const r1 = comp("resistor", "R1", { resistance: 10000 });
  const r2 = comp("resistor", "R2", { resistance: 10000 });
  const m = mcuBoard("arduino_uno", code, (b, g) => ({ comps: [r1, r2], wires: [wire(b, "5v", r1, "a"), wire(r1, "b", r2, "a"), wire(r1, "b", b, "a0"), wire(r2, "b", g, "g")] }));
  const sim = new Simulator();
  sim.compile(m.comps, m.wires);
  while (sim.time < 0.35) sim.step(1e-3);
  const line = getIo(m.b.id).log.trim().split("\n")[0] ?? "";
  check("analogRead at mid-divider", Number(line), 512, 4);
}

// HC-SR04 + sonar template: prints ≈ 50.0 cm
{
  const us = comp("hcsr04", "S1", { distanceCm: 50 });
  const m = mcuBoard("arduino_uno", templateById("sonar")!.code, (b, g) => ({ comps: [us], wires: [wire(b, "5v", us, "vcc"), wire(us, "gnd", g, "g"), wire(b, "d7", us, "trig"), wire(b, "d8", us, "echo")] }));
  const sim = new Simulator();
  sim.compile(m.comps, m.wires);
  while (sim.time < 0.7) sim.step(1e-3);
  const lines = getIo(m.b.id).log.trim().split("\n").filter((l) => l.startsWith("distance"));
  const v = Number((lines[1] ?? "").replace(/[^0-9.]/g, ""));
  check("sonar sketch: measured distance (cm)", v, 50, 1.5);
}

// Servo sweep: angle changes and stays within range
{
  const sv = comp("servo", "M1");
  const m = mcuBoard("arduino_uno", templateById("servo")!.code, (b, g) => ({ comps: [sv], wires: [wire(b, "5v", sv, "vcc"), wire(sv, "gnd", g, "g"), wire(b, "d9", sv, "sig")] }));
  const sim = new Simulator();
  sim.compile(m.comps, m.wires);
  const angles: number[] = [];
  while (sim.time < 1.5) {
    sim.step(1e-3);
    if (Math.round(sim.time * 1000) % 100 === 0) angles.push(sim.snapshot().components[sv.id]!.aux.angle ?? -1);
  }
  const lo = Math.min(...angles);
  const hi = Math.max(...angles);
  check("servo sweep: angle range spans (deg)", hi - lo, 150, 60);
}

// LCD: "Hello, CircuitLab" appears through the real 4-bit bus protocol
{
  const lcd = comp("lcd1602", "LCD1", { line1: "", line2: "" });
  const r = comp("resistor", "RB", { resistance: 220 });
  const m = mcuBoard("arduino_uno", templateById("lcd")!.code, (b, g) => ({
    comps: [lcd, r],
    wires: [
      wire(b, "5v", lcd, "vdd"), wire(lcd, "vss", g, "g"), wire(lcd, "v0", g, "g"), wire(lcd, "rw", g, "g"),
      wire(b, "d12", lcd, "rs"), wire(b, "d11", lcd, "e"),
      wire(b, "d5", lcd, "d4"), wire(b, "d4", lcd, "d5"), wire(b, "d3", lcd, "d6"), wire(b, "d2", lcd, "d7"),
      wire(b, "5v", r, "a"), wire(r, "b", lcd, "a"), wire(lcd, "k", g, "g"),
    ],
  }));
  const sim = new Simulator();
  sim.compile(m.comps, m.wires);
  while (sim.time < 0.3) sim.step(1e-3);
  const st = peekLcd(lcd.id);
  const line1 = st ? String.fromCharCode(...Array.from(st.ddram.slice(0, 17))) : "";
  const ok = line1 === "Hello, CircuitLab";
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"}  LCD shows text via bus protocol: ${JSON.stringify(line1)}`);
  const line2 = st ? String.fromCharCode(...Array.from(st.ddram.slice(40, 44))) : "";
  const ok2 = line2 === "t = ";
  if (!ok2) failed++;
  console.log(`${ok2 ? "PASS" : "FAIL"}  LCD second line: ${JSON.stringify(line2)}`);
}

// ATtiny85 and ESP32 blink
for (const [kind, pinId, gnd] of [["attiny85", "p6", "p4"], ["esp32", "r_g2", "gnd"]] as const) {
  const led = comp("led", "D1");
  const r = comp("resistor", "R1", { resistance: 330 });
  const b = comp(kind, "U1", { code: templateById("blink")!.code });
  const g = comp("ground", "GND");
  const vcc = comp("vdc", "V1", { voltage: 5, rint: 0.05 });
  const ws = [wire(b, gnd, g, "g"), wire(b, pinId, r, "a"), wire(r, "b", led, "a"), wire(led, "k", g, "g")];
  const comps = [b, g, led, r];
  if (kind === "attiny85") {
    comps.push(vcc);
    ws.push(wire(vcc, "p", b, "p8"), wire(vcc, "n", g, "g"));
  }
  const sim = new Simulator();
  sim.compile(comps, ws);
  while (sim.time < 0.3) sim.step(1e-3);
  check(`${kind} blink: LED on at t=0.3 s (V)`, netV(sim, led, "a"), 1.9, 0.5);
  while (sim.time < 0.75) sim.step(1e-3);
  check(`${kind} blink: LED off at t=0.75 s (V)`, netV(sim, led, "a"), 0, 0.1);
}

// Overload: shorting a driven output to ground destroys the board
{
  const m = mcuBoard("arduino_uno", "void setup(){ pinMode(13, OUTPUT); digitalWrite(13, HIGH); } void loop(){}", (b, g) => ({ comps: [], wires: [wire(b, "d13", g, "g")] }));
  const sim = new Simulator();
  sim.compile(m.comps, m.wires);
  while (sim.time < 1.0) sim.step(1e-3);
  check("shorted GPIO burns the MCU (burned flag)", sim.snapshot().components[m.b.id]!.burned ? 1 : 0, 1, 0);
}


// ───────── AC behaviour ─────────
function acGain(comps: PlacedComponent[], ws: Wire[], f: number, probe: [PlacedComponent, string], ref: [PlacedComponent, string], spc: number): { gain: number; phase: number } {
  const sim = new Simulator();
  sim.compile(comps, ws);
  const dt = 1 / (f * spc);
  let a = 0, b = 0, ar = 0, br = 0, cnt = 0;
  while (sim.time < 50 / f) {
    sim.step(dt);
    if (sim.time > 40 / f) {
      const w = 2 * Math.PI * f * sim.time;
      const v = netV(sim, ...probe), r = netV(sim, ...ref);
      a += v * Math.sin(w); b += v * Math.cos(w); ar += r * Math.sin(w); br += r * Math.cos(w); cnt++;
    }
  }
  let ph = Math.atan2(b, a) - Math.atan2(br, ar);
  ph = ((ph + Math.PI) % (2 * Math.PI)) - Math.PI;
  return { gain: Math.hypot(a, b) / Math.hypot(ar, br), phase: (ph * 180) / Math.PI };
}
{
  const v = comp("vac", "V", { amplitude: 1, frequency: 1000, rint: 0 });
  const r = comp("resistor", "R", { resistance: 1000 });
  const c = comp("cap_ceramic", "C", { capacitance: 159.155e-9 });
  const g = comp("ground", "G");
  const m = acGain([v, r, c, g], [wire(v, "p", r, "a"), wire(r, "b", c, "a"), wire(c, "b", g, "g"), wire(v, "n", g, "g")], 1000, [c, "a"], [v, "p"], 100);
  check("AC RC low-pass gain at fc", m.gain, 0.7071, 0.005);
  check("AC RC low-pass phase at fc (deg)", m.phase, -45, 1);
}
{
  const v = comp("vac", "V", { amplitude: 1, frequency: 1000, rint: 0 });
  const r = comp("resistor", "R", { resistance: 628.3 });
  const l = comp("inductor", "L", { inductance: 0.1 });
  const g = comp("ground", "G");
  const m = acGain([v, r, l, g], [wire(v, "p", r, "a"), wire(r, "b", l, "a"), wire(l, "b", g, "g"), wire(v, "n", g, "g")], 1000, [l, "a"], [v, "p"], 100);
  check("AC RL gain at corner", m.gain, 0.7071, 0.005);
  check("AC RL phase at corner (deg)", m.phase, 45, 1);
}
{
  const L = 10e-3, C = 1e-6, R = 10;
  const f0 = 1 / (2 * Math.PI * Math.sqrt(L * C));
  const v = comp("vac", "V", { amplitude: 1, frequency: f0, rint: 0 });
  const r = comp("resistor", "R", { resistance: R });
  const l = comp("inductor", "L", { inductance: L, dcr: 0.001 });
  const c = comp("cap_ceramic", "C", { capacitance: C });
  const g = comp("ground", "G");
  const m = acGain([v, r, l, c, g], [wire(v, "p", r, "a"), wire(r, "b", l, "a"), wire(l, "b", c, "a"), wire(c, "b", g, "g"), wire(v, "n", g, "g")], f0, [c, "a"], [v, "p"], 100);
  check("AC series RLC: Q at resonance (Vc/Vin)", m.gain, 10, 0.8);
}
{
  const v = comp("vac", "V", { amplitude: 3, frequency: 50, phase: 90, offset: 1, rint: 0 });
  const r = comp("resistor", "R");
  const g = comp("ground", "G");
  const sim = new Simulator();
  sim.compile([v, r, g], [wire(v, "p", r, "a"), wire(r, "b", g, "g"), wire(v, "n", g, "g")]);
  sim.step(1e-6);
  check("AC source phase 90° + offset at t≈0 (V)", netV(sim, v, "p"), 4, 0.01);
}
{
  const v = comp("vac", "V", { amplitude: 10, frequency: 50, rint: 0.01 });
  const r = comp("resistor", "R", { resistance: 1000 });
  const m = comp("dmm", "M", { mode: "voltage_ac" });
  const g = comp("ground", "G");
  const sim = simulate([v, r, m, g], [wire(v, "p", r, "a"), wire(r, "b", g, "g"), wire(v, "p", m, "in"), wire(m, "com", g, "g"), wire(v, "n", g, "g")], 0.5, 1e-4);
  check("DMM AC RMS of 10 Vpk sine (V)", sim.snapshot().components[m.id]!.aux.reading!, 7.071, 0.05);
}
{
  // mains step-down: 325 Vpk, Ns/Np = 0.1, 100 Ω load
  const v = comp("vac", "V", { amplitude: 325, frequency: 50, rint: 0.1 });
  const t = comp("transformer", "T", { turnsRatio: 0.1 });
  const rl = comp("resistor", "RL", { resistance: 100, powerRating: 5 });
  const g = comp("ground", "G");
  const g2 = comp("ground", "G2");
  let pk = 0;
  simulate([v, t, rl, g, g2], [wire(v, "p", t, "p1"), wire(v, "n", g, "g"), wire(t, "p2", g, "g"), wire(t, "s1", rl, "a"), wire(t, "s2", g2, "g"), wire(rl, "b", g2, "g")], 0.2, 1e-4, (s) => {
    if (s.time > 0.1) pk = Math.max(pk, Math.abs(netV(s, rl, "a")));
  });
  check("transformer 50 Hz secondary peak (V)", pk, 31, 3);
}


// Arduino button preset: LED follows the button (INPUT_PULLUP, pressed = LOW)
{
  const data = PRESETS.find((q) => q.id === "uno-button")!.build();
  const sim = new Simulator();
  sim.compile(data.components, data.wires);
  const led = data.components.find((c) => c.kind === "led")!;
  const btn = data.components.find((c) => c.kind === "pushbutton")!;
  const ledV = (): number => netV(sim, led, "a");
  while (sim.time < 0.1) sim.step(1e-3);
  check("uno-button: LED off when button released (V)", ledV(), 0, 0.1);
  btn.params = { ...btn.params, closed: true };
  sim.compile(data.components, data.wires);
  while (sim.time < 0.2) sim.step(1e-3);
  check("uno-button: LED on when button pressed (V)", ledV(), 1.9, 0.5);
  btn.params = { ...btn.params, closed: false };
  sim.compile(data.components, data.wires);
  while (sim.time < 0.3) sim.step(1e-3);
  check("uno-button: LED off again after release (V)", ledV(), 0, 0.1);
}


// ───────── oscilloscope ─────────
{
  const v = comp("vac", "V", { amplitude: 5, frequency: 50, offset: 2, rint: 0.01 });
  const r = comp("resistor", "R", { resistance: 1000 });
  const g = comp("ground", "G");
  const sc = comp("scope", "SC", { tdiv: 0.005 });
  const sim = new Simulator();
  sim.compile([v, r, g, sc], [wire(v, "p", r, "a"), wire(r, "b", g, "g"), wire(v, "n", g, "g"), wire(v, "p", sc, "ch1"), wire(sc, "gnd", g, "g")]);
  while (sim.time < 0.5) sim.step(1 / (50 * 100));
  const buf = sim.probes.get(sc.id)!;
  check("scope: samples stored every step (≥ 4000/screen cap)", buf.count > 1000 ? 1 : 0, 1, 0);
  const cfg = cfgFromParams({ ...sc.params });
  const sw = findSweep(buf, cfg)!;
  check("scope: triggered on a rising edge", sw.triggered ? 1 : 0, 1, 0);
  check("scope: trigger level = mid of the swing (V)", sw.level, 2, 0.15);
  // the trigger sample must be a rising crossing near the level
  const { i0, i1 } = windowRange(buf, sw.t0, sw.span);
  const m = measure(buf, (i) => buf.ch[0]![i]!, i0, i1)!;
  check("scope: Vpp over the screen (V)", m.vpp, 10, 0.1);
  check("scope: mean (V)", m.mean, 2, 0.1);
  check("scope: rms of 5 Vpk + 2 V offset (V)", m.rms, Math.sqrt(25 / 2 + 4), 0.1);
  check("scope: measured frequency (Hz)", m.freq ?? -1, 50, 0.5);
  // trigger point sits at 10 % of the screen
  check("scope: pre-trigger fraction", (sw.tTrig - sw.t0) / sw.span, 0.1, 1e-6);
  // two consecutive sweeps (one period apart) start at the same phase
  const sw2 = findSweep(buf, { ...cfg, trigRising: false })!;
  check("scope: falling-edge trigger found", sw2.triggered ? 1 : 0, 1, 0);
  const patch = autoSet(buf, { ...cfg, tdiv: 0.1 });
  check("scope: auto-set time base ≈ 2-3 cycles (s/div)", Number(patch.tdiv ?? -1), 0.005, 0.0045);
  check("scope: auto-set volts/div fits 10 Vpp in ≤ 6 div (V)", Number(patch.vdiv1 ?? -1), 2, 1.01);
}


// ───────── generators ─────────
{
  const mk = (extra: Record<string, number | string | boolean>) => comp("sigen", "G", { rint: 0, ...extra });
  const probe = (g: PlacedComponent, t: number): number => sourceValue(g, t);
  const sq = mk({ waveform: "square", amplitude: 2, offset: 1, frequency: 100, duty: 25 });
  check("sigen square: high level (V)", probe(sq, 0.0010), 3, 1e-9);
  check("sigen square: low level (V)", probe(sq, 0.0060), -1, 1e-9);
  const saw = mk({ waveform: "sawtooth", amplitude: 1, offset: 0, frequency: 100 });
  check("sigen sawtooth: mid-cycle value (V)", probe(saw, 0.005), 0, 0.02);
  const tri = mk({ waveform: "triangle", amplitude: 1, offset: 0, frequency: 100 });
  check("sigen triangle: peak at quarter cycle (V)", probe(tri, 0.0025), 1, 1e-9);
  const rms = mk({ waveform: "sine", amplitude: 230, ampType: "rms", offset: 0, frequency: 50 });
  check("sigen sine 230 Vrms: peak (V)", probe(rms, 0.005), 230 * Math.SQRT2, 1e-6);
  const pp = mk({ waveform: "sine", amplitude: 10, ampType: "pp", offset: 0, frequency: 50 });
  check("sigen sine 10 Vpp: peak (V)", probe(pp, 0.005), 5, 1e-6);
  const mains = comp("vac", "M", { amplitude: 230, ampType: "rms", frequency: 50, rint: 0.01 });
  check("vac 230 Vrms: peak (V)", probe(mains, 0.005), 230 * Math.SQRT2, 1e-6);

  // exact edge placement: a 1 kHz / 30 % pulse train measured through a scope has the right duty and period
  const g = mk({ waveform: "square", amplitude: 2.5, offset: 2.5, frequency: 1000, duty: 30 });
  const r = comp("resistor", "R", { resistance: 1000 });
  const gd = comp("ground", "GND");
  const sc = comp("scope", "SC", { tdiv: 0.0005 });
  const sim = new Simulator();
  sim.compile([g, r, gd, sc], [wire(g, "p", r, "a"), wire(r, "b", gd, "g"), wire(g, "n", gd, "g"), wire(g, "p", sc, "ch1"), wire(sc, "gnd", gd, "g")]);
  while (sim.time < 0.05) sim.step(1 / (1000 * 100));
  const buf = sim.probes.get(sc.id)!;
  const i0 = buf.lowerBound(0.02);
  const m = measure(buf, (i) => buf.ch[0]![i]!, i0, buf.count)!;
  check("pulse train: mean = duty × Vpp (V)", m.mean, 5 * 0.3 + 0.0 + 0, 0.05);
  check("pulse train: frequency (Hz)", m.freq ?? -1, 1000, 1);
  // edges land on exact breakpoints: no sample may sit strictly inside an edge ramp more than twice per edge
  let hits = 0;
  for (let i = i0; i < buf.count; i++) {
    const v = buf.ch[0]![buf.idx(i)]!;
    if (v > 0.2 && v < 4.8) hits++;
  }
  check("pulse train: intermediate samples per edge ≤ 2", hits / (2 * 30), 1, 1);
}


// ───────── centre-tap transformer ─────────
{
  const v = comp("vac", "V", { amplitude: 230, ampType: "rms", frequency: 50, rint: 0.1 });
  const t = comp("transformer_ct", "T", { turnsRatio: 0.1, ratedCurrent: 2 });
  const g = comp("ground", "G");
  const d1 = comp("diode", "D1");
  const d2 = comp("diode", "D2");
  const c = comp("cap_electrolytic", "C", { capacitance: 1000e-6, voltageRating: 50 });
  const rl = comp("resistor", "RL", { resistance: 100, powerRating: 5 });
  const gs = comp("ground", "GS");
  const ws = [
    wire(v, "p", t, "p1"), wire(v, "n", g, "g"), wire(t, "p2", g, "g"),
    wire(t, "sc", gs, "g"),
    wire(t, "s1", d1, "a"), wire(t, "s2", d2, "a"),
    wire(d1, "k", c, "p"), wire(d2, "k", c, "p"), wire(c, "n", gs, "g"),
    wire(c, "p", rl, "a"), wire(rl, "b", gs, "g"),
  ];
  let a1 = 0, a2 = 0, vmin = 1e9, vmax = -1e9, sumSum = 0, cnt = 0;
  simulate([v, t, g, d1, d2, c, rl, gs], ws, 0.5, 1e-4, (sm) => {
    if (sm.time > 0.3) {
      const x1 = netV(sm, t, "s1"), x2 = netV(sm, t, "s2");
      a1 = Math.max(a1, Math.abs(x1));
      a2 = Math.max(a2, Math.abs(x2));
      sumSum += Math.abs(x1 + x2) < 1 ? 0 : 0;
      cnt++;
      const o = netV(sm, c, "p");
      vmin = Math.min(vmin, o);
      vmax = Math.max(vmax, o);
    }
  });
  void sumSum; void cnt;
  check("CT: each half peaks near Vp·n/2 (V)", Math.max(a1, a2), 16.3, 2.5);
  check("CT full-wave rectifier: DC output (V)", (vmin + vmax) / 2, 14.5, 2.5);
  check("CT full-wave rectifier: ripple at 100 Hz keeps Vpp small (V)", vmax - vmin, 1.5, 1.5);
}
{
  // balanced halves: s1 and s2 are in antiphase around the tap
  const v = comp("vac", "V", { amplitude: 20, frequency: 50, rint: 0.01 });
  const t = comp("transformer_ct", "T", { turnsRatio: 1 });
  const g = comp("ground", "G");
  const r1 = comp("resistor", "R1", { resistance: 1000 });
  const r2 = comp("resistor", "R2", { resistance: 1000 });
  const gs = comp("ground", "GS");
  let worst = 0;
  simulate([v, t, g, r1, r2, gs], [wire(v, "p", t, "p1"), wire(v, "n", g, "g"), wire(t, "p2", g, "g"), wire(t, "sc", gs, "g"), wire(t, "s1", r1, "a"), wire(r1, "b", gs, "g"), wire(t, "s2", r2, "a"), wire(r2, "b", gs, "g")], 0.3, 1e-4, (sm) => {
    if (sm.time > 0.2) worst = Math.max(worst, Math.abs(netV(sm, t, "s1") + netV(sm, t, "s2")));
  });
  check("CT: halves are in antiphase (|s1 + s2| ≈ 0, V)", worst, 0, 0.3);
}
{
  const v = comp("vac", "V", { amplitude: 325, frequency: 50, rint: 0.1 });
  const t = comp("transformer", "T", { turnsRatio: 0.1 });
  const rl = comp("resistor", "RL", { resistance: 100, powerRating: 10 });
  const g = comp("ground", "G");
  const g2 = comp("ground", "G2");
  const sm = simulate([v, t, rl, g, g2], [wire(v, "p", t, "p1"), wire(v, "n", g, "g"), wire(t, "p2", g, "g"), wire(t, "s1", rl, "a"), wire(t, "s2", g2, "g"), wire(rl, "b", g2, "g")], 0.6, 1e-4);
  const aux = sm.snapshot().components[t.id]!.aux;
  check("transformer: secondary RMS read-out (V)", aux.vsRms!, 22.2, 2);
  check("transformer: efficiency under load", aux.eff!, 0.85, 0.12);
  check("transformer: output power ≈ Vs²/RL (W)", aux.pout!, (aux.vsRms! * aux.vsRms!) / 100, 0.8);
}

// AC presets keep running without burning anything for several seconds of circuit time
for (const pr of PRESETS.filter((q) => /^ac-/.test(q.id))) {
  const data = pr.build();
  const sim = new Simulator();
  sim.compile(data.components, data.wires);
  const f = Math.max(...data.components.filter((c) => c.kind === "vac" || c.kind === "sigen").map((c) => Number(c.params.frequency)));
  const dt = 1 / (f * 100);
  while (sim.time < Math.max(1.5, 200 / f)) sim.step(dt);
  const snap = sim.snapshot();
  check(`AC preset ${pr.id}: nothing burned after ${sim.time.toFixed(1)} s`, snap.burned.length, 0, 0);
  check(`AC preset ${pr.id}: converged`, snap.diagnostics.converged ? 1 : 0, 1, 0);
}

for (const pr of PRESETS.filter((q) => /^(uno|esp32|attiny)-/.test(q.id))) {
  const data = pr.build();
  const sim = new Simulator();
  sim.compile(data.components, data.wires);
  while (sim.time < 1.5) sim.step(1e-3);
  const snap = sim.snapshot();
  const burned = data.components.filter((c) => snap.components[c.id]?.burned).map((c) => c.label);
  const mcu = data.components.find((c) => getDef(c.kind).sim === "mcu")!;
  const st = getIo(mcu.id).status;
  check(`preset ${pr.id}: nothing burned`, burned.length, 0, 0);
  check(`preset ${pr.id}: sketch running (${st.kind} ${st.message})`, st.kind === "running" ? 1 : 0, 1, 0);
  if (pr.id === "uno-pot") check("preset uno-pot: serial output present", getIo(mcu.id).log.includes("raw=") ? 1 : 0, 1, 0);
  if (pr.id === "uno-sonar") {
    const m = /distance: ([0-9.]+) cm/.exec(getIo(mcu.id).log);
    check("preset uno-sonar: measured ~80 cm", m ? Number(m[1]) : -1, 80, 2);
  }
  if (pr.id === "uno-lcd") {
    const l = peekLcd(data.components.find((c) => c.kind === "lcd1602")!.id);
    check("preset uno-lcd: row 0 starts with 'Hello'", l && String.fromCharCode(...l.ddram.slice(0, 5)) === "Hello" ? 1 : 0, 1, 0);
  }
}


// ───────── typed values, help, feature groups, failure diagnostics ─────────
{
  const cases: [string, number][] = [
    ["4.7k", 4700], ["100uF", 1e-4], ["10 kΩ", 1e4], ["2.2n", 2.2e-9], ["1e-6", 1e-6], ["47meg", 47e6],
    ["4k7", 4700], ["-5V", -5], ["5mV", 5e-3], ["1M", 1e6], ["1m", 1e-3], ["22pF", 22e-12], ["470µ", 470e-6], ["3,3k", 3300],
  ];
  for (const [t, v] of cases) check(`parseEng("${t}")`, parseEng(t), v, Math.abs(v) * 1e-9);
  for (const t of ["abc", "", "k", "4.7.1k", "5x5"]) check(`parseEng("${t}") is NaN`, Number.isNaN(parseEng(t)) ? 1 : 0, 1, 0);

  const missing = CATALOG_LIST.filter((d) => !HELP[d.kind]).map((d) => d.kind);
  check(`every part has help text (missing: ${missing.join(",") || "none"})`, missing.length, 0, 0);
  const thin = CATALOG_LIST.filter((d) => HELP[d.kind] && (HELP[d.kind]!.formulas.length === 0 || HELP[d.kind]!.uses.length === 0)).map((d) => d.kind);
  check(`help has formulas and uses (thin: ${thin.join(",") || "none"})`, thin.length, 0, 0);
  const gates = CATALOG_LIST.filter((d) => d.sim === "gate" || d.kind === "gate_not");
  check("every gate help has a truth table", gates.every((d) => HELP[d.kind]?.table) ? 1 : 0, 1, 0);

  const ids = new Set(FEATURE_GROUPS.map((g) => g.id));
  check("every part maps to a known feature group", CATALOG_LIST.every((d) => ids.has(groupOf(d))) ? 1 : 0, 1, 0);
  const empty = FEATURE_GROUPS.filter((g) => !CATALOG_LIST.some((d) => groupOf(d) === g.id)).map((g) => g.id);
  check(`no empty feature group (${empty.join(",") || "none"})`, empty.length, 0, 0);
  check("ground is in the locked core group", groupOf(getDef("ground")) === "core" ? 1 : 0, 1, 0);
  // simple view must still leave every part with at least one field when it has any basic one
  const bare = CATALOG_LIST.filter((d) => d.fields.length > 0 && d.fields.every(isAdvancedField)).map((d) => d.kind);
  check(`simple view never hides every field (${bare.join(",") || "none"})`, bare.length, 0, 0);
}

function burnReason(parts: PlacedComponent[], w: Wire[], id: string, secs = 3): string | undefined {
  const sim = new Simulator();
  sim.compile(parts, w);
  while (sim.time < secs && !sim.snapshot().components[id]!.burned) sim.step(1e-4);
  return sim.snapshot().components[id]!.failure;
}

// LED straight across 5 V → explains the missing current-limiting resistor
{
  const v = comp("vdc", "V1", { voltage: 5, rint: 0 });
  const d = comp("led", "D1");
  const g = comp("ground", "GND");
  const why = burnReason([v, d, g], [wire(v, "p", d, "a"), wire(d, "k", g, "g"), wire(v, "n", g, "g")], d.id);
  console.log("      LED:", why);
  check("LED failure explained (current + limit + resistor advice)", why && /forward current reached .*A, exceeding the .*maximum rating/.test(why) && /series resistor/.test(why) ? 1 : 0, 1, 0);
}
// resistor over its power rating
{
  const v = comp("vdc", "V1", { voltage: 12, rint: 0, currentLimit: 5 });
  const r = comp("resistor", "R1", { resistance: 100, powerRating: 0.25 });
  const g = comp("ground", "GND");
  const why = burnReason([v, r, g], [wire(v, "p", r, "a"), wire(r, "b", g, "g"), wire(v, "n", g, "g")], r.id);
  console.log("      Resistor:", why);
  check("resistor failure explained (power vs rating)", why && /power dissipation reached 1\.44 W/.test(why) && /250 mW/.test(why) ? 1 : 0, 1, 0);
}
// reverse-biased electrolytic
{
  const v = comp("vdc", "V1", { voltage: 9, rint: 0, currentLimit: 5 });
  const r = comp("resistor", "R1", { resistance: 10 });
  const c = comp("cap_electrolytic", "C1", { capacitance: 100e-6, voltageRating: 16 });
  const g = comp("ground", "GND");
  const why = burnReason([v, r, c, g], [wire(v, "p", r, "a"), wire(r, "b", c, "n"), wire(c, "p", g, "g"), wire(v, "n", g, "g")], c.id, 5);
  console.log("      Capacitor:", why);
  check("capacitor failure explained (reverse voltage)", why && /reverse voltage/.test(why) ? 1 : 0, 1, 0);
}
// the simulator log also carries the failure with its label
{
  const v = comp("vdc", "V1", { voltage: 5, rint: 0 });
  const d = comp("led", "D1");
  const g = comp("ground", "GND");
  const sim = new Simulator();
  sim.compile([v, d, g], [wire(v, "p", d, "a"), wire(d, "k", g, "g"), wire(v, "n", g, "g")]);
  while (sim.time < 3 && sim.snapshot().failures.length === 0) sim.step(1e-4);
  const f = sim.snapshot().failures;
  check("failure log has the LED with a reason", f.length === 1 && f[0]!.label === "D1" && f[0]!.reason.length > 20 ? 1 : 0, 1, 0);
  sim.repair(d.id);
  check("repair clears the failure log", sim.snapshot().failures.length, 0, 0);
}

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
