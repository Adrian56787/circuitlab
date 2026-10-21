import type {
  CategoryId,
  CategoryInfo,
  ComponentDef,
  PackageStyle,
  ParamField,
  Params,
  PinDef,
  PinKind,
  SimModel,
} from "./types";

export const CATEGORIES: CategoryInfo[] = [
  { id: "passive", label: "Passive", accent: "#ffb020" },
  { id: "semiconductor", label: "Semiconductors", accent: "#2fd8ff" },
  { id: "ic", label: "Integrated Circuits", accent: "#b38bff" },
  { id: "power", label: "Power & Sources", accent: "#ff4d5e" },
  { id: "input", label: "Input & Sensors", accent: "#39ff88" },
  { id: "output", label: "Output & Indicators", accent: "#ff7ad9" },
  { id: "instrument", label: "Instruments", accent: "#4d8dff" },
];

// ───────────────────────── helpers ─────────────────────────

const pin = (id: string, label: string, x: number, y: number, kind: PinKind = "passive"): PinDef => ({
  id,
  label,
  x,
  y,
  kind,
});

const num = (
  key: string,
  label: string,
  unit: Extract<ParamField, { type: "number" }>["unit"],
  extra: Partial<Extract<ParamField, { type: "number" }>> = {},
): ParamField => ({ key, label, type: "number", unit, ...extra });

const sel = (key: string, label: string, options: [string, string][]): ParamField => ({
  key,
  label,
  type: "select",
  options: options.map(([value, l]) => ({ value, label: l })),
});

interface Spec {
  kind: string;
  name: string;
  category: CategoryId;
  description: string;
  bounds: [number, number, number, number];
  body?: [number, number, number, number];
  alsoIn?: CategoryId[];
  pins: PinDef[];
  defaults?: Params;
  fields?: ParamField[];
  symbol: string;
  pkg: PackageStyle;
  sim: SimModel;
  tags?: string[];
  prefix: string;
}

function def(s: Spec): ComponentDef {
  return {
    ...s,
    defaults: s.defaults ?? {},
    fields: s.fields ?? [],
    tags: s.tags ?? [],
  };
}

/** Standard 2-terminal horizontal footprint. */
const TWO_H: PinDef[] = [pin("a", "A", 0, 0), pin("b", "B", 4, 0)];
const TWO_H_BOUNDS: [number, number, number, number] = [0, -1, 4, 1];
const diodePins: PinDef[] = [pin("a", "A", 0, 0), pin("k", "K", 4, 0)];

/** Vertical 2-terminal source footprint, + on top. */
const SRC_V: PinDef[] = [pin("p", "+", 0, 0, "power"), pin("n", "−", 0, 4, "ground")];
const SRC_BOUNDS: [number, number, number, number] = [-1, 0, 1, 4];

/**
 * Build a DIP style IC: pins 1..n/2 on the left going down, remainder on
 * the right going up (standard numbering). `names` are indexed by pin number − 1.
 */
function dipPins(names: string[], kinds: Record<string, PinKind> = {}, width = 6): PinDef[] {
  const n = names.length;
  const half = n / 2;
  const out: PinDef[] = [];
  for (let i = 0; i < n; i++) {
    const label = names[i]!;
    const kind = kinds[label] ?? "io";
    if (i < half) out.push(pin(`p${i + 1}`, label, 0, i + 1, kind));
    else out.push(pin(`p${i + 1}`, label, width, n - i, kind));
  }
  return out;
}

function dipBox(n: number, width = 6): { bounds: [number, number, number, number]; body: [number, number, number, number] } {
  const half = n / 2;
  return { bounds: [0, 0, width, half + 1], body: [1, 0.5, width - 1, half + 0.5] };
}

// ───────────────────────── catalog ─────────────────────────

const R_FIELDS: ParamField[] = [
  num("resistance", "Resistance", "ohm", { min: 0.001, max: 1e9 }),
  sel("tolerance", "Tolerance", [
    ["1", "±1 %"],
    ["2", "±2 %"],
    ["5", "±5 %"],
    ["10", "±10 %"],
  ]),
  num("powerRating", "Power rating", "watt", { min: 0.01, max: 1000 }),
];

const LED_COLORS: [string, string][] = [
  ["red", "Red"],
  ["green", "Green"],
  ["blue", "Blue"],
  ["yellow", "Yellow"],
  ["orange", "Orange"],
  ["white", "White"],
];

export const LED_VF: Record<string, number> = {
  red: 1.9,
  orange: 2.0,
  yellow: 2.1,
  green: 2.2,
  blue: 3.0,
  white: 3.1,
};

const defs: ComponentDef[] = [
  // ─────────── PASSIVE ───────────
  def({
    kind: "resistor",
    name: "Resistor",
    category: "passive",
    description: "Fixed carbon-film resistor with colour-code bands.",
    bounds: TWO_H_BOUNDS,
    pins: TWO_H,
    defaults: { resistance: 1000, tolerance: "5", powerRating: 0.25 },
    fields: R_FIELDS,
    symbol: "resistor",
    pkg: "axial",
    sim: "resistor",
    tags: ["resistance", "ohm"],
    prefix: "R",
  }),
  def({
    kind: "cap_ceramic",
    name: "Capacitor · Ceramic",
    category: "passive",
    description: "Non-polarised ceramic disc capacitor.",
    bounds: TWO_H_BOUNDS,
    pins: TWO_H,
    defaults: { capacitance: 100e-9, voltageRating: 50 },
    fields: [
      num("capacitance", "Capacitance", "farad", { min: 1e-13, max: 1 }),
      num("voltageRating", "Voltage rating", "volt", { min: 1, max: 5000 }),
    ],
    symbol: "capacitor",
    pkg: "ceramic",
    sim: "capacitor",
    tags: ["capacitor", "cap", "mlcc"],
    prefix: "C",
  }),
  def({
    kind: "cap_electrolytic",
    name: "Capacitor · Electrolytic",
    category: "passive",
    description: "Polarised aluminium electrolytic capacitor. Reverse voltage damages it.",
    bounds: TWO_H_BOUNDS,
    pins: [pin("p", "+", 0, 0), pin("n", "−", 4, 0)],
    defaults: { capacitance: 100e-6, voltageRating: 16 },
    fields: [
      num("capacitance", "Capacitance", "farad", { min: 1e-9, max: 10 }),
      num("voltageRating", "Voltage rating", "volt", { min: 1, max: 1000 }),
    ],
    symbol: "capacitor_pol",
    pkg: "electrolytic",
    sim: "capacitor",
    tags: ["capacitor", "polarised", "elco"],
    prefix: "C",
  }),
  def({
    kind: "cap_tantalum",
    name: "Capacitor · Tantalum",
    category: "passive",
    description: "Polarised tantalum capacitor. Fails short when over-volted.",
    bounds: TWO_H_BOUNDS,
    pins: [pin("p", "+", 0, 0), pin("n", "−", 4, 0)],
    defaults: { capacitance: 10e-6, voltageRating: 10 },
    fields: [
      num("capacitance", "Capacitance", "farad", { min: 1e-9, max: 1e-2 }),
      num("voltageRating", "Voltage rating", "volt", { min: 1, max: 100 }),
    ],
    symbol: "capacitor_pol",
    pkg: "tantalum",
    sim: "capacitor",
    tags: ["capacitor", "polarised"],
    prefix: "C",
  }),
  def({
    kind: "inductor",
    name: "Inductor",
    category: "passive",
    description: "Air or ferrite-core inductor with series winding resistance.",
    bounds: TWO_H_BOUNDS,
    pins: TWO_H,
    defaults: { inductance: 10e-3, dcr: 0.5, currentRating: 1 },
    fields: [
      num("inductance", "Inductance", "henry", { min: 1e-9, max: 100 }),
      num("dcr", "Winding resistance", "ohm", { min: 0, max: 1e4 }),
      num("currentRating", "Current rating", "amp", { min: 0.001, max: 100 }),
    ],
    symbol: "inductor",
    pkg: "coil",
    sim: "inductor",
    tags: ["coil", "choke"],
    prefix: "L",
  }),
  def({
    kind: "transformer",
    name: "Transformer",
    category: "passive",
    description: "Two-winding transformer (visual only in this build).",
    bounds: [0, 0, 4, 4],
    pins: [pin("p1", "P1", 0, 0), pin("p2", "P2", 0, 4), pin("s1", "S1", 4, 0), pin("s2", "S2", 4, 4)],
    defaults: { turnsRatio: 0.1 },
    fields: [{ key: "turnsRatio", label: "Turns ratio (Ns/Np)", type: "slider", min: 0.01, max: 10, step: 0.01 }],
    symbol: "transformer",
    pkg: "transformer",
    sim: "none",
    tags: ["mains", "coil"],
    prefix: "T",
  }),
  def({
    kind: "potentiometer",
    name: "Potentiometer",
    category: "passive",
    description: "Three-terminal variable resistor with adjustable wiper.",
    bounds: [0, -1, 4, 2],
    alsoIn: ["input"],
    pins: [pin("a", "A", 0, 0), pin("b", "B", 4, 0), pin("w", "W", 2, 2)],
    defaults: { resistance: 10000, wiper: 50 },
    fields: [
      num("resistance", "Total resistance", "ohm", { min: 1, max: 1e8 }),
      { key: "wiper", label: "Wiper position (%)", type: "slider", min: 0, max: 100, step: 1 },
    ],
    symbol: "pot",
    pkg: "pot",
    sim: "potentiometer",
    tags: ["variable", "volume", "rotary"],
    prefix: "RV",
  }),
  def({
    kind: "trimmer",
    name: "Trimmer",
    category: "passive",
    description: "Small preset trimmer potentiometer.",
    bounds: [0, -1, 4, 2],
    pins: [pin("a", "A", 0, 0), pin("b", "B", 4, 0), pin("w", "W", 2, 2)],
    defaults: { resistance: 10000, wiper: 50 },
    fields: [
      num("resistance", "Total resistance", "ohm", { min: 1, max: 1e8 }),
      { key: "wiper", label: "Wiper position (%)", type: "slider", min: 0, max: 100, step: 1 },
    ],
    symbol: "trimmer",
    pkg: "pot",
    sim: "potentiometer",
    tags: ["preset", "variable"],
    prefix: "RV",
  }),

  // ─────────── SEMICONDUCTORS ───────────
  def({
    kind: "diode",
    name: "Diode · Rectifier",
    category: "semiconductor",
    description: "General-purpose silicon rectifier (1N400x family).",
    bounds: TWO_H_BOUNDS,
    pins: diodePins,
    defaults: { vf: 0.7, maxCurrent: 1 },
    fields: [
      num("vf", "Forward voltage @10 mA", "volt", { min: 0.1, max: 5, step: 0.05 }),
      num("maxCurrent", "Max forward current", "amp", { min: 0.001, max: 100 }),
    ],
    symbol: "diode",
    pkg: "diode",
    sim: "diode",
    tags: ["1n4007", "1n4148", "rectifier"],
    prefix: "D",
  }),
  def({
    kind: "zener",
    name: "Diode · Zener",
    category: "semiconductor",
    description: "Voltage reference diode that conducts in reverse at Vz.",
    bounds: TWO_H_BOUNDS,
    pins: diodePins,
    defaults: { vf: 0.7, vz: 5.1, maxPower: 0.5 },
    fields: [
      num("vf", "Forward voltage @10 mA", "volt", { min: 0.1, max: 5, step: 0.05 }),
      num("vz", "Zener voltage", "volt", { min: 1.8, max: 200, step: 0.1 }),
      num("maxPower", "Max power", "watt", { min: 0.1, max: 50 }),
    ],
    symbol: "zener",
    pkg: "diode",
    sim: "diode",
    tags: ["regulator", "reference"],
    prefix: "D",
  }),
  def({
    kind: "schottky",
    name: "Diode · Schottky",
    category: "semiconductor",
    description: "Low forward drop, fast switching Schottky diode.",
    bounds: TWO_H_BOUNDS,
    pins: diodePins,
    defaults: { vf: 0.3, maxCurrent: 1 },
    fields: [
      num("vf", "Forward voltage @10 mA", "volt", { min: 0.1, max: 1, step: 0.05 }),
      num("maxCurrent", "Max forward current", "amp", { min: 0.001, max: 100 }),
    ],
    symbol: "schottky",
    pkg: "diode",
    sim: "diode",
    tags: ["1n5819", "fast"],
    prefix: "D",
  }),
  def({
    kind: "led",
    name: "LED",
    category: "semiconductor",
    description: "Light emitting diode. Brightness follows current; over-current burns it out.",
    bounds: TWO_H_BOUNDS,
    alsoIn: ["output"],
    pins: diodePins,
    defaults: { color: "red", vf: 1.9, maxCurrent: 0.03 },
    fields: [
      sel("color", "Colour", LED_COLORS),
      num("vf", "Forward voltage @10 mA", "volt", { min: 1, max: 5, step: 0.05 }),
      num("maxCurrent", "Max forward current", "amp", { min: 0.001, max: 1 }),
    ],
    symbol: "led",
    pkg: "led",
    sim: "diode",
    tags: ["light", "indicator"],
    prefix: "D",
  }),
  def({
    kind: "bjt_npn",
    name: "BJT · NPN",
    category: "semiconductor",
    description: "NPN bipolar junction transistor (2N3904 class).",
    bounds: [0, -2, 2, 2],
    pins: [pin("b", "B", 0, 0), pin("c", "C", 2, -2), pin("e", "E", 2, 2)],
    defaults: { beta: 150, maxIc: 0.2, maxPower: 0.625 },
    fields: [
      num("beta", "Beta (hFE)", "none", { min: 5, max: 1000, step: 5 }),
      num("maxIc", "Max collector current", "amp", { min: 0.01, max: 100 }),
      num("maxPower", "Max power", "watt", { min: 0.1, max: 200 }),
    ],
    symbol: "npn",
    pkg: "to92",
    sim: "bjt",
    tags: ["2n3904", "2n2222", "transistor"],
    prefix: "Q",
  }),
  def({
    kind: "bjt_pnp",
    name: "BJT · PNP",
    category: "semiconductor",
    description: "PNP bipolar junction transistor (2N3906 class).",
    bounds: [0, -2, 2, 2],
    pins: [pin("b", "B", 0, 0), pin("c", "C", 2, 2), pin("e", "E", 2, -2)],
    defaults: { beta: 150, maxIc: 0.2, maxPower: 0.625 },
    fields: [
      num("beta", "Beta (hFE)", "none", { min: 5, max: 1000, step: 5 }),
      num("maxIc", "Max collector current", "amp", { min: 0.01, max: 100 }),
      num("maxPower", "Max power", "watt", { min: 0.1, max: 200 }),
    ],
    symbol: "pnp",
    pkg: "to92",
    sim: "bjt",
    tags: ["2n3906", "transistor"],
    prefix: "Q",
  }),
  def({
    kind: "nmos",
    name: "MOSFET · N-Channel",
    category: "semiconductor",
    description: "Enhancement-mode N-channel power MOSFET (IRLZ44 class).",
    bounds: [0, -2, 2, 2],
    pins: [pin("g", "G", 0, 0), pin("d", "D", 2, -2), pin("s", "S", 2, 2)],
    defaults: { vth: 2, kp: 1, maxId: 10, maxPower: 20 },
    fields: [
      num("vth", "Threshold Vgs(th)", "volt", { min: 0.3, max: 10, step: 0.1 }),
      num("kp", "Transconductance k", "none", { min: 0.001, max: 100, step: 0.1, help: "A/V² (W/L included)" }),
      num("maxId", "Max drain current", "amp", { min: 0.1, max: 200 }),
      num("maxPower", "Max power", "watt", { min: 0.1, max: 500 }),
    ],
    symbol: "nmos",
    pkg: "to220",
    sim: "mosfet",
    tags: ["irlz44", "2n7000", "fet"],
    prefix: "Q",
  }),
  def({
    kind: "pmos",
    name: "MOSFET · P-Channel",
    category: "semiconductor",
    description: "Enhancement-mode P-channel MOSFET.",
    bounds: [0, -2, 2, 2],
    pins: [pin("g", "G", 0, 0), pin("d", "D", 2, 2), pin("s", "S", 2, -2)],
    defaults: { vth: 2, kp: 1, maxId: 10, maxPower: 20 },
    fields: [
      num("vth", "Threshold |Vgs(th)|", "volt", { min: 0.3, max: 10, step: 0.1 }),
      num("kp", "Transconductance k", "none", { min: 0.001, max: 100, step: 0.1 }),
      num("maxId", "Max drain current", "amp", { min: 0.1, max: 200 }),
      num("maxPower", "Max power", "watt", { min: 0.1, max: 500 }),
    ],
    symbol: "pmos",
    pkg: "to220",
    sim: "mosfet",
    tags: ["irf9540", "fet"],
    prefix: "Q",
  }),
  def({
    kind: "jfet_n",
    name: "JFET · N-Channel",
    category: "semiconductor",
    description: "N-channel junction FET (visual only in this build).",
    bounds: [0, -2, 2, 2],
    pins: [pin("g", "G", 0, 0), pin("d", "D", 2, -2), pin("s", "S", 2, 2)],
    defaults: { idss: 0.01, vp: -3 },
    fields: [
      num("idss", "Idss", "amp", { min: 1e-4, max: 1 }),
      num("vp", "Pinch-off Vp", "volt", { min: -20, max: -0.2, step: 0.1 }),
    ],
    symbol: "jfet_n",
    pkg: "to92",
    sim: "none",
    tags: ["j201", "2n5457", "fet"],
    prefix: "Q",
  }),
  def({
    kind: "scr",
    name: "Thyristor · SCR",
    category: "semiconductor",
    description: "Silicon-controlled rectifier (visual only in this build).",
    bounds: [0, -2, 2, 2],
    pins: [pin("a", "A", 2, -2), pin("k", "K", 2, 2), pin("g", "G", 0, 1)],
    defaults: { igt: 0.005, vdrm: 400 },
    fields: [num("igt", "Gate trigger current", "amp"), num("vdrm", "Blocking voltage", "volt")],
    symbol: "scr",
    pkg: "to220",
    sim: "none",
    tags: ["thyristor"],
    prefix: "Q",
  }),
  def({
    kind: "triac",
    name: "Triac",
    category: "semiconductor",
    description: "Bidirectional AC switch (visual only in this build).",
    bounds: [0, -2, 2, 2],
    pins: [pin("mt1", "MT1", 2, 2), pin("mt2", "MT2", 2, -2), pin("g", "G", 0, 1)],
    defaults: { igt: 0.01, vdrm: 600 },
    fields: [num("igt", "Gate trigger current", "amp"), num("vdrm", "Blocking voltage", "volt")],
    symbol: "triac",
    pkg: "to220",
    sim: "none",
    tags: ["ac", "thyristor"],
    prefix: "Q",
  }),
  def({
    kind: "optocoupler",
    name: "Optocoupler",
    category: "semiconductor",
    description: "LED + phototransistor isolator, e.g. PC817 (visual only in this build).",
    bounds: [0, -2, 4, 2],
    pins: [pin("a", "A", 0, -1), pin("k", "K", 0, 1), pin("c", "C", 4, -1), pin("e", "E", 4, 1)],
    defaults: { ctr: 100 },
    fields: [num("ctr", "Current transfer ratio (%)", "none", { min: 10, max: 600 })],
    symbol: "opto",
    pkg: "dip",
    sim: "none",
    tags: ["pc817", "isolator"],
    prefix: "U",
  }),

  // ─────────── INTEGRATED CIRCUITS ───────────
  def({
    kind: "ic555",
    name: "555 Timer",
    category: "ic",
    description: "NE555 bipolar timer. Astable and monostable operation.",
    ...dipBox(8, 8),
    pins: dipPins(
      ["GND", "TRIG", "OUT", "RESET", "CTRL", "THR", "DIS", "VCC"],
      { GND: "ground", VCC: "power", OUT: "output", TRIG: "input", THR: "input", RESET: "input", CTRL: "analog", DIS: "io" },
      8,
    ),
    defaults: {},
    symbol: "ic",
    pkg: "dip",
    sim: "timer555",
    tags: ["ne555", "timer", "oscillator"],
    prefix: "U",
  }),
  def({
    kind: "ua741",
    name: "Op-Amp · UA741",
    category: "ic",
    description: "Classic general-purpose op-amp. Output swings to ~1.5 V of the rails.",
    bounds: [0, -3, 6, 3],
    pins: [
      pin("inp", "+", 0, -1, "input"),
      pin("inn", "−", 0, 1, "input"),
      pin("out", "OUT", 6, 0, "output"),
      pin("vcc", "V+", 3, -3, "power"),
      pin("vee", "V−", 3, 3, "ground"),
    ],
    defaults: { gain: 200000, headroom: 1.5 },
    fields: [
      num("gain", "Open-loop gain", "none", { min: 1000, max: 1e7 }),
      num("headroom", "Rail headroom", "volt", { min: 0, max: 4, step: 0.1 }),
    ],
    symbol: "opamp",
    pkg: "dip",
    sim: "opamp",
    tags: ["op amp", "amplifier", "uA741"],
    prefix: "U",
  }),
  def({
    kind: "lm358",
    name: "Op-Amp · LM358",
    category: "ic",
    description: "Single-supply op-amp (one of two channels). Output can reach the negative rail.",
    bounds: [0, -3, 6, 3],
    pins: [
      pin("inp", "+", 0, -1, "input"),
      pin("inn", "−", 0, 1, "input"),
      pin("out", "OUT", 6, 0, "output"),
      pin("vcc", "V+", 3, -3, "power"),
      pin("vee", "V−", 3, 3, "ground"),
    ],
    defaults: { gain: 100000, headroom: 1.5 },
    fields: [
      num("gain", "Open-loop gain", "none", { min: 1000, max: 1e7 }),
      num("headroom", "High-rail headroom", "volt", { min: 0, max: 4, step: 0.1 }),
    ],
    symbol: "opamp",
    pkg: "dip",
    sim: "opamp",
    tags: ["op amp", "comparator", "single supply"],
    prefix: "U",
  }),
  ...[
    { kind: "reg7805", name: "Regulator · 7805", vout: 5, label: "78xx" },
    { kind: "reg7812", name: "Regulator · 7812", vout: 12, label: "78xx" },
    { kind: "reg7905", name: "Regulator · 7905", vout: -5, label: "79xx" },
  ].map((r) =>
    def({
      kind: r.kind,
      name: r.name,
      category: "ic",
      description: `Fixed linear regulator, ${r.vout} V output, ~2 V dropout.`,
      bounds: [0, 0, 6, 4],
      body: [1, 0.5, 5, 3.5],
      pins:
        r.vout > 0
          ? [pin("in", "IN", 0, 1, "power"), pin("gnd", "GND", 3, 4, "ground"), pin("out", "OUT", 6, 1, "output")]
          : [pin("gnd", "GND", 0, 1, "ground"), pin("in", "IN", 3, 4, "power"), pin("out", "OUT", 6, 1, "output")],
      defaults: { vout: r.vout, dropout: 2, maxCurrent: 1.5 },
      fields: [
        num("vout", "Output voltage", "volt", { min: -30, max: 30, step: 0.1 }),
        num("dropout", "Dropout", "volt", { min: 0, max: 5, step: 0.1 }),
        num("maxCurrent", "Max current", "amp", { min: 0.1, max: 10 }),
      ],
      symbol: "regulator",
      pkg: "to220",
      sim: "regulator",
      tags: ["linear", "regulator", r.label, "voltage"],
      prefix: "U",
    }),
  ),
  def({
    kind: "lm317",
    name: "Regulator · LM317",
    category: "ic",
    description: "Adjustable regulator: Vout = 1.25 V × (1 + R2/R1) + Iadj·R2.",
    bounds: [0, 0, 6, 4],
    body: [1, 0.5, 5, 3.5],
    pins: [pin("in", "IN", 0, 1, "power"), pin("adj", "ADJ", 3, 4, "analog"), pin("out", "OUT", 6, 1, "output")],
    defaults: { dropout: 2, maxCurrent: 1.5 },
    fields: [
      num("dropout", "Dropout", "volt", { min: 0, max: 5, step: 0.1 }),
      num("maxCurrent", "Max current", "amp", { min: 0.1, max: 10 }),
    ],
    symbol: "regulator",
    pkg: "to220",
    sim: "regulator",
    tags: ["adjustable", "regulator"],
    prefix: "U",
  }),
  ...(
    [
      ["gate_and", "Gate · AND", "and"],
      ["gate_or", "Gate · OR", "or"],
      ["gate_not", "Gate · NOT", "not"],
      ["gate_nand", "Gate · NAND", "nand"],
      ["gate_nor", "Gate · NOR", "nor"],
      ["gate_xor", "Gate · XOR", "xor"],
    ] as const
  ).map(([kind, name, fn]) =>
    def({
      kind,
      name,
      category: "ic",
      description: `7400-series ${fn.toUpperCase()} gate with implicit supply. Outputs swing 0 V – supply.`,
      bounds: [0, -2, 6, 2],
      pins:
        fn === "not"
          ? [pin("a", "A", 0, 0, "input"), pin("y", "Y", 6, 0, "output")]
          : [pin("a", "A", 0, -1, "input"), pin("b", "B", 0, 1, "input"), pin("y", "Y", 6, 0, "output")],
      defaults: { fn, supply: 5, rout: 50 },
      fields: [
        num("supply", "Supply voltage", "volt", { min: 1.8, max: 15, step: 0.1 }),
        num("rout", "Output resistance", "ohm", { min: 1, max: 1e4 }),
      ],
      symbol: `gate_${fn}`,
      pkg: "dip",
      sim: "gate",
      tags: ["logic", "7400", "74hc"],
      prefix: "U",
    }),
  ),
  def({
    kind: "arduino_uno",
    name: "Arduino Uno",
    category: "ic",
    description: "ATmega328P board. Pinout mapped; code simulation arrives with the editor module.",
    bounds: [0, 0, 9, 18],
    body: [1, 0, 8, 18],
    pins: [
      pin("reset", "RESET", 0, 1, "input"),
      pin("3v3", "3V3", 0, 2, "power"),
      pin("5v", "5V", 0, 3, "power"),
      pin("gnd1", "GND", 0, 4, "ground"),
      pin("gnd2", "GND", 0, 5, "ground"),
      pin("vin", "VIN", 0, 6, "power"),
      ...[0, 1, 2, 3, 4, 5].map((i) => pin(`a${i}`, `A${i}`, 0, 8 + i, "analog")),
      ...Array.from({ length: 14 }, (_, i) => pin(`d${i}`, `D${i}`, 9, 1 + i, "io")),
      pin("aref", "AREF", 9, 15, "analog"),
      pin("gnd3", "GND", 9, 16, "ground"),
    ],
    defaults: { sketch: "arduino_blink" },
    symbol: "ic",
    pkg: "module",
    sim: "mcu",
    tags: ["atmega328", "microcontroller", "arduino"],
    prefix: "U",
  }),
  def({
    kind: "esp32",
    name: "ESP32 DevKit",
    category: "ic",
    description: "ESP32-WROOM devkit with the common GPIO pinout.",
    bounds: [0, 0, 9, 17],
    body: [1, 0, 8, 17],
    pins: [
      ...["EN", "3V3", "GND", "VIN", "G36", "G39", "G34", "G35", "G32", "G33", "G25", "G26", "G27", "G14", "G12"].map(
        (l, i) =>
          pin(l.toLowerCase(), l, 0, 1 + i, l === "3V3" || l === "VIN" ? "power" : l === "GND" ? "ground" : "io"),
      ),
      ...["GND", "G23", "G22", "TX", "RX", "G21", "G19", "G18", "G5", "G17", "G16", "G4", "G0", "G2", "G15"].map(
        (l, i) => pin(`r_${l.toLowerCase()}`, l, 9, 1 + i, l === "GND" ? "ground" : "io"),
      ),
    ],
    defaults: { sketch: "esp32_blink" },
    symbol: "ic",
    pkg: "module",
    sim: "mcu",
    tags: ["wifi", "bluetooth", "microcontroller"],
    prefix: "U",
  }),
  def({
    kind: "attiny85",
    name: "ATtiny85",
    category: "ic",
    description: "8-pin AVR microcontroller.",
    ...dipBox(8, 8),
    pins: dipPins(["PB5", "PB3", "PB4", "GND", "PB0", "PB1", "PB2", "VCC"], { GND: "ground", VCC: "power" }, 8),
    defaults: { sketch: "attiny_blink" },
    symbol: "ic",
    pkg: "dip",
    sim: "mcu",
    tags: ["avr", "microcontroller", "digispark"],
    prefix: "U",
  }),

  // ─────────── POWER ───────────
  def({
    kind: "ground",
    name: "Ground",
    category: "power",
    description: "0 V reference. Every simulated circuit needs one.",
    bounds: [-1, 0, 1, 2],
    pins: [pin("g", "GND", 0, 0, "ground")],
    symbol: "ground",
    pkg: "generic",
    sim: "ground",
    tags: ["gnd", "reference", "earth"],
    prefix: "GND",
  }),
  def({
    kind: "vdc",
    name: "DC Power Supply",
    category: "power",
    description: "Bench supply with adjustable voltage and current limit.",
    bounds: SRC_BOUNDS,
    pins: SRC_V,
    defaults: { voltage: 5, currentLimit: 1, rint: 0.05 },
    fields: [
      num("voltage", "Voltage", "volt", { min: -100, max: 100, step: 0.1 }),
      num("currentLimit", "Current limit", "amp", { min: 0.01, max: 50 }),
      num("rint", "Output resistance", "ohm", { min: 0, max: 100 }),
    ],
    symbol: "vdc",
    pkg: "module",
    sim: "vsource",
    tags: ["supply", "bench", "dc"],
    prefix: "V",
  }),
  def({
    kind: "vac",
    name: "AC Voltage Source",
    category: "power",
    description: "Sinusoidal source with amplitude, frequency, phase and offset.",
    bounds: SRC_BOUNDS,
    pins: [pin("p", "~", 0, 0, "power"), pin("n", "~", 0, 4, "ground")],
    defaults: { amplitude: 5, frequency: 50, offset: 0, phase: 0, rint: 0.01 },
    fields: [
      num("amplitude", "Peak amplitude", "volt", { min: 0, max: 400, step: 0.1 }),
      num("frequency", "Frequency", "hertz", { min: 0.01, max: 1e7 }),
      num("offset", "DC offset", "volt", { min: -100, max: 100, step: 0.1 }),
      num("phase", "Phase (deg)", "none", { min: -360, max: 360 }),
      num("rint", "Source resistance", "ohm", { min: 0, max: 1000 }),
    ],
    symbol: "vac",
    pkg: "module",
    sim: "vsource",
    tags: ["ac", "sine", "mains"],
    prefix: "V",
  }),
  ...(
    [
      ["battery_9v", "Battery · 9 V", 9, 1.5, "9 V PP3 alkaline battery."],
      ["battery_aa", "Battery · 1.5 V AA", 1.5, 0.15, "AA alkaline cell."],
      ["battery_lipo", "Battery · LiPo", 3.7, 0.08, "Single-cell lithium polymer pack."],
    ] as const
  ).map(([kind, name, v, r, d]) =>
    def({
      kind,
      name,
      category: "power",
      description: d,
      bounds: SRC_BOUNDS,
      pins: SRC_V,
      defaults: { voltage: v, rint: r, capacityAh: kind === "battery_9v" ? 0.5 : kind === "battery_aa" ? 2.4 : 2 },
      fields: [
        num("voltage", "Nominal voltage", "volt", { min: 0.5, max: 60, step: 0.1 }),
        num("rint", "Internal resistance", "ohm", { min: 0, max: 100 }),
      ],
      symbol: "battery",
      pkg: "battery",
      sim: "vsource",
      tags: ["cell", "power"],
      prefix: "BT",
    }),
  ),
  def({
    kind: "sigen",
    name: "Signal Generator",
    category: "power",
    description: "Function generator: sine, square, triangle or PWM.",
    bounds: SRC_BOUNDS,
    pins: [pin("p", "OUT", 0, 0, "output"), pin("n", "GND", 0, 4, "ground")],
    defaults: { waveform: "square", amplitude: 2.5, offset: 2.5, frequency: 1, duty: 50, rint: 50 },
    fields: [
      sel("waveform", "Waveform", [
        ["sine", "Sine"],
        ["square", "Square"],
        ["triangle", "Triangle"],
        ["pwm", "PWM"],
      ]),
      num("amplitude", "Amplitude (peak)", "volt", { min: 0, max: 50, step: 0.1 }),
      num("offset", "DC offset", "volt", { min: -50, max: 50, step: 0.1 }),
      num("frequency", "Frequency", "hertz", { min: 0.01, max: 1e7 }),
      { key: "duty", label: "Duty cycle (%)", type: "slider", min: 1, max: 99, step: 1 },
      num("rint", "Output resistance", "ohm", { min: 0, max: 1000 }),
    ],
    symbol: "sigen",
    pkg: "module",
    sim: "vsource",
    tags: ["function", "pwm", "waveform"],
    prefix: "G",
  }),

  // ─────────── INPUT & SENSORS ───────────
  def({
    kind: "pushbutton",
    name: "Push Button",
    category: "input",
    description: "Momentary switch. Hold the mouse on it during simulation to close.",
    bounds: [0, -2, 4, 1],
    pins: TWO_H,
    defaults: { closed: false, momentary: true },
    symbol: "button",
    pkg: "switch",
    sim: "switch",
    tags: ["button", "tactile"],
    prefix: "SW",
  }),
  def({
    kind: "toggle_switch",
    name: "Toggle Switch",
    category: "input",
    description: "SPST toggle. Click to flip during simulation.",
    bounds: [0, -2, 4, 1],
    pins: TWO_H,
    defaults: { closed: false },
    symbol: "switch",
    pkg: "switch",
    sim: "switch",
    tags: ["switch", "spst"],
    prefix: "SW",
  }),
  def({
    kind: "dip_switch",
    name: "DIP Switch ×4",
    category: "input",
    description: "Four independent SPST switches in a DIP package.",
    bounds: [0, 0, 6, 5],
    body: [1, 0.5, 5, 4.5],
    pins: [
      ...[1, 2, 3, 4].map((i) => pin(`a${i}`, String(i), 0, i, "io")),
      ...[1, 2, 3, 4].map((i) => pin(`b${i}`, String(i), 6, i, "io")),
    ],
    defaults: { s1: false, s2: false, s3: false, s4: false },
    symbol: "dip",
    pkg: "dip",
    sim: "switch",
    tags: ["dip", "switch", "bank"],
    prefix: "SW",
  }),
  def({
    kind: "ldr",
    name: "LDR · Photoresistor",
    category: "input",
    description: "Light dependent resistor. Resistance falls as illumination rises.",
    bounds: TWO_H_BOUNDS,
    pins: TWO_H,
    defaults: { lux: 100, r10lux: 10000, gamma: 0.7 },
    fields: [
      { key: "lux", label: "Illuminance (lux)", type: "slider", min: 1, max: 1000, step: 1 },
      num("r10lux", "R @ 10 lux", "ohm", { min: 100, max: 1e7 }),
      num("gamma", "Gamma", "none", { min: 0.3, max: 1.2, step: 0.05 }),
    ],
    symbol: "ldr",
    pkg: "ceramic",
    sim: "resistor",
    tags: ["light", "sensor", "photoresistor"],
    prefix: "R",
  }),
  def({
    kind: "ntc",
    name: "Thermistor · NTC",
    category: "input",
    description: "Negative temperature coefficient thermistor (Steinhart / β model).",
    bounds: TWO_H_BOUNDS,
    pins: TWO_H,
    defaults: { r25: 10000, beta: 3950, temp: 25 },
    fields: [
      num("r25", "R @ 25 °C", "ohm", { min: 1, max: 1e7 }),
      num("beta", "β constant", "none", { min: 1000, max: 8000, step: 50 }),
      { key: "temp", label: "Temperature (°C)", type: "slider", min: -40, max: 150, step: 1 },
    ],
    symbol: "ntc",
    pkg: "ceramic",
    sim: "resistor",
    tags: ["temperature", "sensor", "thermistor"],
    prefix: "RT",
  }),
  def({
    kind: "ptc",
    name: "Thermistor · PTC",
    category: "input",
    description: "Positive temperature coefficient thermistor.",
    bounds: TWO_H_BOUNDS,
    pins: TWO_H,
    defaults: { r25: 100, alpha: 0.007, temp: 25 },
    fields: [
      num("r25", "R @ 25 °C", "ohm", { min: 1, max: 1e6 }),
      num("alpha", "Temp. coefficient (1/°C)", "none", { min: 0.001, max: 0.05, step: 0.001 }),
      { key: "temp", label: "Temperature (°C)", type: "slider", min: -40, max: 150, step: 1 },
    ],
    symbol: "ptc",
    pkg: "ceramic",
    sim: "resistor",
    tags: ["temperature", "sensor", "polyfuse"],
    prefix: "RT",
  }),
  def({
    kind: "hcsr04",
    name: "Ultrasonic · HC-SR04",
    category: "input",
    description: "Ultrasonic ranger module (visual only in this build).",
    bounds: [0, 0, 6, 7],
    body: [0, 0, 6, 6],
    pins: [pin("vcc", "VCC", 1, 7, "power"), pin("trig", "TRIG", 2, 7, "input"), pin("echo", "ECHO", 4, 7, "output"), pin("gnd", "GND", 5, 7, "ground")],
    defaults: { distanceCm: 50 },
    fields: [{ key: "distanceCm", label: "Distance (cm)", type: "slider", min: 2, max: 400, step: 1 }],
    symbol: "sonar",
    pkg: "module",
    sim: "none",
    tags: ["distance", "ultrasonic", "sensor"],
    prefix: "U",
  }),

  // ─────────── OUTPUT ───────────
  def({
    kind: "led_rgb",
    name: "LED · RGB",
    category: "output",
    description: "Common-cathode RGB LED: three diodes sharing one cathode.",
    bounds: [0, 0, 4, 5],
    body: [1, 0.5, 4, 4.5],
    pins: [pin("r", "R", 0, 1, "input"), pin("g", "G", 0, 2, "input"), pin("b", "B", 0, 3, "input"), pin("com", "K", 4, 2, "ground")],
    defaults: { maxCurrent: 0.02, common: "cathode" },
    fields: [num("maxCurrent", "Max current / channel", "amp", { min: 0.001, max: 0.5 })],
    symbol: "led_rgb",
    pkg: "led",
    sim: "diodeArray",
    tags: ["rgb", "light"],
    prefix: "D",
  }),
  def({
    kind: "sevenseg",
    name: "7-Segment Display",
    category: "output",
    description: "Common-cathode single digit. Drive segments a–g and dp through resistors.",
    bounds: [0, 0, 6, 10],
    body: [1, 0.5, 6, 9.5],
    pins: [
      ...["a", "b", "c", "d", "e", "f", "g", "dp"].map((l, i) => pin(l, l, 0, 1 + i, "input")),
      pin("com", "COM", 6, 5, "ground"),
    ],
    defaults: { maxCurrent: 0.02, common: "cathode" },
    fields: [num("maxCurrent", "Max current / segment", "amp", { min: 0.001, max: 0.5 })],
    symbol: "sevenseg",
    pkg: "dip",
    sim: "diodeArray",
    tags: ["display", "digit", "led"],
    prefix: "DS",
  }),
  def({
    kind: "lcd1602",
    name: "LCD 16×2",
    category: "output",
    description: "HD44780 character display (visual only in this build).",
    bounds: [0, 0, 14, 10],
    body: [1, 0.5, 13, 9.5],
    pins: [
      ...["VSS", "VDD", "V0", "RS", "RW", "E", "A", "K"].map((l, i) =>
        pin(l.toLowerCase(), l, 0, 1 + i, l === "VDD" ? "power" : l === "VSS" || l === "K" ? "ground" : "input"),
      ),
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => pin(`d${i}`, `D${i}`, 14, 1 + i, "io")),
    ],
    defaults: { line1: "HELLO, WORLD", line2: "CircuitLab" },
    fields: [
      { key: "line1", label: "Line 1", type: "text" },
      { key: "line2", label: "Line 2", type: "text" },
    ],
    symbol: "lcd",
    pkg: "module",
    sim: "none",
    tags: ["hd44780", "display", "text"],
    prefix: "LCD",
  }),
  def({
    kind: "buzzer",
    name: "Buzzer",
    category: "output",
    description: "Active piezo buzzer modelled as a resistive load.",
    bounds: [0, -1.5, 4, 1.5],
    pins: [pin("p", "+", 0, 0, "power"), pin("n", "−", 4, 0, "ground")],
    defaults: { resistance: 100, maxVoltage: 12 },
    fields: [
      num("resistance", "Coil resistance", "ohm", { min: 5, max: 1e5 }),
      num("maxVoltage", "Max voltage", "volt", { min: 1, max: 60 }),
    ],
    symbol: "buzzer",
    pkg: "module",
    sim: "load",
    tags: ["sound", "piezo", "alarm"],
    prefix: "BZ",
  }),
  def({
    kind: "dc_motor",
    name: "DC Motor",
    category: "output",
    description: "Brushed DC motor with winding resistance and back-EMF constant.",
    bounds: [0, -1.5, 4, 1.5],
    pins: [pin("p", "+", 0, 0, "power"), pin("n", "−", 4, 0, "ground")],
    defaults: { resistance: 12, maxVoltage: 12, stallCurrent: 1 },
    fields: [
      num("resistance", "Winding resistance", "ohm", { min: 0.1, max: 1000 }),
      num("maxVoltage", "Rated voltage", "volt", { min: 1, max: 60 }),
    ],
    symbol: "motor",
    pkg: "module",
    sim: "load",
    tags: ["motor", "actuator"],
    prefix: "M",
  }),
  def({
    kind: "servo",
    name: "Servo Motor",
    category: "output",
    description: "Hobby servo, 3-wire PWM interface (visual only in this build).",
    bounds: [0, 0, 8, 5],
    body: [1, 0.5, 8, 4.5],
    pins: [pin("gnd", "GND", 0, 1, "ground"), pin("vcc", "V+", 0, 2, "power"), pin("sig", "SIG", 0, 3, "input")],
    defaults: { angle: 90 },
    fields: [{ key: "angle", label: "Angle (deg)", type: "slider", min: 0, max: 180, step: 1 }],
    symbol: "servo",
    pkg: "module",
    sim: "none",
    tags: ["sg90", "actuator", "pwm"],
    prefix: "M",
  }),
  def({
    kind: "relay",
    name: "Relay · SPDT",
    category: "output",
    description: "Electromechanical relay. Coil current above pull-in closes COM–NO.",
    bounds: [0, -3, 6, 3],
    body: [1, -2.5, 5, 2.5],
    pins: [
      pin("c1", "C1", 0, -1, "input"),
      pin("c2", "C2", 0, 1, "input"),
      pin("nc", "NC", 6, -2),
      pin("com", "COM", 6, 0),
      pin("no", "NO", 6, 2),
    ],
    defaults: { coilResistance: 400, pullIn: 0.7, dropOut: 0.1, state: false },
    fields: [
      num("coilResistance", "Coil resistance", "ohm", { min: 10, max: 1e5 }),
      { key: "pullIn", label: "Pull-in (× rated)", type: "slider", min: 0.3, max: 1, step: 0.05 },
    ],
    symbol: "relay",
    pkg: "module",
    sim: "relay",
    tags: ["switch", "coil", "actuator"],
    prefix: "K",
  }),

  // ─────────── INSTRUMENTS ───────────
  def({
    kind: "dmm",
    name: "Digital Multimeter",
    category: "instrument",
    description: "Volts, amps or ohms. Wire in parallel for V, in series for A.",
    bounds: [0, 0, 7, 8],
    body: [1, 0, 7, 8],
    pins: [pin("in", "V/Ω/A", 0, 3, "analog"), pin("com", "COM", 0, 5, "ground")],
    defaults: { mode: "voltage" },
    fields: [
      sel("mode", "Mode", [
        ["voltage", "Voltage (DC)"],
        ["current", "Current (DC)"],
        ["resistance", "Resistance"],
      ]),
    ],
    symbol: "dmm",
    pkg: "module",
    sim: "meter",
    tags: ["multimeter", "voltmeter", "ammeter", "ohmmeter"],
    prefix: "M",
  }),
  def({
    kind: "scope",
    name: "Oscilloscope · 2ch",
    category: "instrument",
    description: "Dual-channel scope. Adjust V/div and time/div in the inspector.",
    bounds: [0, 0, 12, 9],
    body: [1, 0, 12, 9],
    pins: [pin("ch1", "CH1", 0, 3, "analog"), pin("ch2", "CH2", 0, 5, "analog"), pin("gnd", "GND", 0, 7, "ground")],
    defaults: { vdiv1: 1, vdiv2: 1, tdiv: 0.001, trigger: 0.5 },
    fields: [
      num("vdiv1", "CH1 volts/div", "volt", { min: 0.001, max: 100 }),
      num("vdiv2", "CH2 volts/div", "volt", { min: 0.001, max: 100 }),
      num("tdiv", "Time/div", "second", { min: 1e-6, max: 10 }),
      num("trigger", "Trigger level", "volt", { min: -100, max: 100, step: 0.1 }),
    ],
    symbol: "scope",
    pkg: "module",
    sim: "meter",
    tags: ["oscilloscope", "waveform", "probe"],
    prefix: "SC",
  }),
  def({
    kind: "logic_analyzer",
    name: "Logic Analyzer",
    category: "instrument",
    description: "Eight digital channels with threshold detection.",
    bounds: [0, 0, 12, 11],
    body: [1, 0, 12, 11],
    pins: [
      ...[0, 1, 2, 3, 4, 5, 6, 7].map((i) => pin(`d${i}`, `D${i}`, 0, 1 + i, "input")),
      pin("gnd", "GND", 0, 10, "ground"),
    ],
    defaults: { threshold: 1.6, tdiv: 0.001 },
    fields: [
      num("threshold", "Logic threshold", "volt", { min: 0.1, max: 12, step: 0.1 }),
      num("tdiv", "Time/div", "second", { min: 1e-6, max: 10 }),
    ],
    symbol: "logic",
    pkg: "module",
    sim: "meter",
    tags: ["logic", "digital", "analyser"],
    prefix: "LA",
  }),
];

export const CATALOG: ReadonlyMap<string, ComponentDef> = new Map(defs.map((d) => [d.kind, d]));

export const CATALOG_LIST: readonly ComponentDef[] = defs;

export function getDef(kind: string): ComponentDef {
  const d = CATALOG.get(kind);
  if (!d) throw new Error(`Unknown component kind: ${kind}`);
  return d;
}

export function pinDef(kind: string, pinId: string): PinDef | undefined {
  return CATALOG.get(kind)?.pins.find((p) => p.id === pinId);
}

export function searchCatalog(query: string): ComponentDef[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...defs];
  const terms = q.split(/\s+/);
  return defs.filter((d) => {
    const hay = `${d.name} ${d.kind} ${d.description} ${d.tags.join(" ")}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  });
}
