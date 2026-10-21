import { Simulator } from "../src/engine/simulator";
import { getDef } from "../src/models/catalog";
import type { PlacedComponent, Wire } from "../src/models/types";

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

console.log(failed === 0 ? "\nALL PASSED" : `\n${failed} FAILED`);
process.exit(failed === 0 ? 0 : 1);
