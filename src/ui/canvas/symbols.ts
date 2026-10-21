import { LED_VF } from "@/models/catalog";
import { BAND_COLORS, resistanceToBands } from "@/models/resistorColor";
import { formatEng } from "@/models/units";
import { probes } from "@/engine/probes";
import type { ComponentDef, ComponentSnapshot, PlacedComponent, Rotation } from "@/models/types";

/**
 * Drawing routines for every part, in LOCAL GRID COORDINATES: the caller has already
 * translated/rotated/mirrored the context and scaled it so that 1 unit = 1 grid cell.
 */

export interface DrawOpts {
  view: "schematic" | "physical";
  stroke: string;
  dim: string;
  accent: string;
  snap?: ComponentSnapshot;
  rotation: Rotation;
  mirror: boolean;
  burned: boolean;
  /** performance.now() in ms, for animation. */
  now: number;
}

const GRID = 20;
const LW = 0.09;
const TAU = Math.PI * 2;

const LED_RGB_HEX: Record<string, string> = {
  red: "#ff2a2a",
  green: "#2bff6a",
  blue: "#3a6bff",
  yellow: "#ffe62a",
  orange: "#ff9a1f",
  white: "#f4f8ff",
};

type C = CanvasRenderingContext2D;

let ORIENT: { rot: number; mirror: boolean } = { rot: 0, mirror: false };

// ───────────────────────── helpers ─────────────────────────

function line(c: C, ...p: number[]): void {
  c.beginPath();
  c.moveTo(p[0]!, p[1]!);
  for (let i = 2; i < p.length; i += 2) c.lineTo(p[i]!, p[i + 1]!);
  c.stroke();
}
function poly(c: C, close: boolean, ...p: number[]): void {
  c.beginPath();
  c.moveTo(p[0]!, p[1]!);
  for (let i = 2; i < p.length; i += 2) c.lineTo(p[i]!, p[i + 1]!);
  if (close) c.closePath();
}
function circle(c: C, x: number, y: number, r: number, fill?: string): void {
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
  if (fill) {
    c.fillStyle = fill;
    c.fill();
  }
  c.stroke();
}
function rrect(c: C, x: number, y: number, w: number, h: number, r: number): void {
  c.beginPath();
  c.roundRect(x, y, w, h, r);
}

/** Text that stays upright and unmirrored regardless of part orientation. */
function text(c: C, s: string, x: number, y: number, px: number, align: CanvasTextAlign = "center", color?: string): void {
  c.save();
  c.translate(x, y);
  if (ORIENT.mirror) c.scale(-1, 1);
  c.rotate((-ORIENT.rot * Math.PI) / 180);
  c.scale(1 / GRID, 1 / GRID);
  c.font = `${px}px ui-monospace, Menlo, Consolas, monospace`;
  c.textAlign = align;
  c.textBaseline = "middle";
  if (color) c.fillStyle = color;
  c.fillText(s, 0, 0);
  c.restore();
}

function num(p: PlacedComponent, k: string, d: number): number {
  const v = p.params[k];
  return typeof v === "number" ? v : d;
}
function str(p: PlacedComponent, k: string, d: string): string {
  const v = p.params[k];
  return typeof v === "string" ? v : d;
}
function flag(p: PlacedComponent, k: string): boolean {
  return p.params[k] === true;
}

function glow(c: C, x: number, y: number, r: number, color: string, a: number): void {
  if (a <= 0.01) return;
  const g = c.createRadialGradient(x, y, 0, x, y, r);
  g.addColorStop(0, color);
  g.addColorStop(1, "transparent");
  c.save();
  c.globalAlpha = Math.min(1, a);
  c.globalCompositeOperation = "lighter";
  c.fillStyle = g;
  c.beginPath();
  c.arc(x, y, r, 0, TAU);
  c.fill();
  c.restore();
}

/** Horizontal leads for a 2-terminal part spanning x = 0…4. */
function leads2(c: C, x0 = 1, x1 = 3, y = 0): void {
  line(c, 0, y, x0, y);
  line(c, x1, y, 4, y);
}

function arrowHead(c: C, x: number, y: number, ang: number, s = 0.28): void {
  c.save();
  c.translate(x, y);
  c.rotate(ang);
  c.fillStyle = c.strokeStyle as string;
  c.beginPath();
  c.moveTo(0, 0);
  c.lineTo(-s, -s * 0.45);
  c.lineTo(-s, s * 0.45);
  c.closePath();
  c.fill();
  c.restore();
}

// ───────────────────────── schematic symbols ─────────────────────────

type Sym = (c: C, p: PlacedComponent, d: ComponentDef, o: DrawOpts) => void;

const SCHEM: Record<string, Sym> = {
  resistor(c, p) {
    leads2(c);
    const n = 6;
    const pts: number[] = [1, 0];
    for (let i = 0; i < n; i++) pts.push(1 + (i + 0.5) * (2 / n), i % 2 === 0 ? -0.35 : 0.35);
    pts.push(3, 0);
    line(c, ...pts);
    void p;
  },
  capacitor(c) {
    line(c, 0, 0, 1.85, 0);
    line(c, 2.15, 0, 4, 0);
    line(c, 1.85, -0.65, 1.85, 0.65);
    line(c, 2.15, -0.65, 2.15, 0.65);
  },
  capacitor_pol(c, _p, _d, o) {
    line(c, 0, 0, 1.85, 0);
    line(c, 2.25, 0, 4, 0);
    line(c, 1.85, -0.65, 1.85, 0.65);
    c.beginPath();
    c.arc(2.9, 0, 0.7, Math.PI * 0.78, Math.PI * 1.22);
    c.stroke();
    text(c, "+", 1.4, -0.5, 11, "center", o.stroke);
  },
  inductor(c) {
    line(c, 0, 0, 0.8, 0);
    line(c, 3.2, 0, 4, 0);
    c.beginPath();
    for (let i = 0; i < 4; i++) c.arc(1.2 + i * 0.6, 0, 0.3, Math.PI, 0, false);
    c.stroke();
  },
  transformer(c) {
    line(c, 0, 0, 1.2, 0, 1.2, 0.2);
    line(c, 0, 4, 1.2, 4, 1.2, 3.8);
    line(c, 4, 0, 2.8, 0, 2.8, 0.2);
    line(c, 4, 4, 2.8, 4, 2.8, 3.8);
    for (const x of [1.2, 2.8]) {
      c.beginPath();
      for (let i = 0; i < 4; i++) c.arc(x, 0.5 + i * 0.75, 0.375, -Math.PI / 2, Math.PI / 2, x > 2);
      c.stroke();
    }
    line(c, 1.9, 0.3, 1.9, 3.7);
    line(c, 2.1, 0.3, 2.1, 3.7);
  },
  pot(c) {
    SCHEM.resistor!(c, null as never, null as never, null as never);
    line(c, 2, 2, 2, 0.55);
    arrowHead(c, 2, 0.5, -Math.PI / 2);
  },
  trimmer(c) {
    SCHEM.resistor!(c, null as never, null as never, null as never);
    line(c, 2, 2, 2, 0.55);
    arrowHead(c, 2, 0.5, -Math.PI / 2);
    line(c, 1.7, 1.2, 2.3, 1.2);
  },
  diode(c) {
    leads2(c, 1.4, 2.6);
    poly(c, true, 1.4, -0.6, 1.4, 0.6, 2.6, 0);
    c.stroke();
    line(c, 2.6, -0.6, 2.6, 0.6);
  },
  zener(c) {
    leads2(c, 1.4, 2.6);
    poly(c, true, 1.4, -0.6, 1.4, 0.6, 2.6, 0);
    c.stroke();
    line(c, 2.3, -0.6, 2.6, -0.6, 2.6, 0.6, 2.9, 0.6);
  },
  schottky(c) {
    leads2(c, 1.4, 2.6);
    poly(c, true, 1.4, -0.6, 1.4, 0.6, 2.6, 0);
    c.stroke();
    line(c, 2.3, -0.4, 2.3, -0.6, 2.6, -0.6, 2.6, 0.6, 2.9, 0.6, 2.9, 0.4);
  },
  led(c, p, _d, o) {
    SCHEM.diode!(c, p, _d, o);
    line(c, 1.9, -0.85, 2.5, -1.45);
    line(c, 2.3, -0.65, 2.9, -1.25);
    arrowHead(c, 2.5, -1.45, -Math.PI / 4, 0.22);
    arrowHead(c, 2.9, -1.25, -Math.PI / 4, 0.22);
  },
  npn(c) {
    bjt(c, false);
  },
  pnp(c) {
    bjt(c, true);
  },
  nmos(c) {
    mos(c, false);
  },
  pmos(c) {
    mos(c, true);
  },
  jfet_n(c) {
    line(c, 0, 0, 1, 0);
    line(c, 1, -0.8, 1, 0.8);
    line(c, 1, -0.55, 2, -0.55, 2, -2);
    line(c, 1, 0.55, 2, 0.55, 2, 2);
    arrowHead(c, 1, 0, 0, 0.25);
  },
  scr(c) {
    line(c, 2, -2, 2, -0.7);
    line(c, 2, 0.7, 2, 2);
    poly(c, true, 1.4, -0.7, 2.6, -0.7, 2, 0.5);
    c.stroke();
    line(c, 1.4, 0.7, 2.6, 0.7);
    line(c, 0, 1, 1, 1, 1.7, 0.7);
  },
  triac(c) {
    line(c, 2, -2, 2, -0.8);
    line(c, 2, 0.8, 2, 2);
    line(c, 1.3, 0, 2.7, 0);
    poly(c, true, 1.4, -0.8, 2.6, -0.8, 2, 0);
    c.stroke();
    poly(c, true, 1.4, 0.8, 2.6, 0.8, 2, 0);
    c.stroke();
    line(c, 0, 1, 1, 1, 1.5, 0.45);
  },
  opto(c, _p, _d, o) {
    rrect(c, 0.8, -1.8, 2.4, 3.6, 0.1);
    c.stroke();
    line(c, 0, -1, 1.4, -1);
    line(c, 0, 1, 1.4, 1);
    poly(c, true, 1.1, -0.4, 1.7, -0.4, 1.4, 0.2);
    c.stroke();
    line(c, 1.1, 0.2, 1.7, 0.2);
    line(c, 1.4, -1, 1.4, -0.4);
    line(c, 1.4, 0.2, 1.4, 1);
    line(c, 4, -1, 2.8, -1, 2.3, -0.4);
    line(c, 4, 1, 2.8, 1, 2.3, 0.4);
    line(c, 2.3, -0.6, 2.3, 0.6);
    line(c, 1.9, -0.2, 2.3, -0.15);
    text(c, "OPTO", 2, 1.5, 9, "center", o.dim);
  },
  ic: boxSymbol,
  regulator: boxSymbol,
  opamp(c, p, _d, o) {
    line(c, 0, -1, 1, -1);
    line(c, 0, 1, 1, 1);
    line(c, 5.6, 0, 6, 0);
    poly(c, true, 1, -2.5, 1, 2.5, 5.6, 0);
    c.stroke();
    line(c, 3, -3, 3, -1.4);
    line(c, 3, 3, 3, 1.4);
    text(c, "+", 1.45, -1, 12, "center", o.stroke);
    text(c, "−", 1.45, 1, 12, "center", o.stroke);
    text(c, p.kind === "lm358" ? "LM358" : "741", 2.6, 0, 9, "center", o.dim);
  },
  gate_and: (c, p, d, o) => gate(c, "and", o),
  gate_nand: (c, p, d, o) => gate(c, "nand", o),
  gate_or: (c, p, d, o) => gate(c, "or", o),
  gate_nor: (c, p, d, o) => gate(c, "nor", o),
  gate_xor: (c, p, d, o) => gate(c, "xor", o),
  gate_not: (c, p, d, o) => gate(c, "not", o),
  ground(c) {
    line(c, 0, 0, 0, 0.7);
    line(c, -0.7, 0.7, 0.7, 0.7);
    line(c, -0.45, 1.1, 0.45, 1.1);
    line(c, -0.2, 1.5, 0.2, 1.5);
  },
  vdc(c, _p, _d, o) {
    line(c, 0, 0, 0, 1);
    line(c, 0, 3, 0, 4);
    circle(c, 0, 2, 1);
    text(c, "+", 0, 1.35, 12, "center", o.stroke);
    text(c, "−", 0, 2.65, 12, "center", o.stroke);
  },
  vac(c) {
    line(c, 0, 0, 0, 1);
    line(c, 0, 3, 0, 4);
    circle(c, 0, 2, 1);
    c.beginPath();
    for (let i = 0; i <= 24; i++) {
      const t = i / 24;
      const x = -0.6 + 1.2 * t;
      const y = 2 - 0.35 * Math.sin(t * TAU);
      if (i === 0) c.moveTo(x, y);
      else c.lineTo(x, y);
    }
    c.stroke();
  },
  sigen(c, p) {
    line(c, 0, 0, 0, 1);
    line(c, 0, 3, 0, 4);
    circle(c, 0, 2, 1);
    c.beginPath();
    const wf = str(p, "waveform", "square");
    for (let i = 0; i <= 32; i++) {
      const t = i / 32;
      const x = -0.65 + 1.3 * t;
      let y: number;
      if (wf === "sine") y = Math.sin(t * TAU);
      else if (wf === "triangle") y = 1 - 4 * Math.abs(((t * 1.5) % 1) - 0.5);
      else if (wf === "pwm") y = ((t * 2) % 1) < 0.3 ? 1 : -1;
      else y = ((t * 2) % 1) < 0.5 ? 1 : -1;
      const yy = 2 - 0.35 * y;
      if (i === 0) c.moveTo(x, yy);
      else c.lineTo(x, yy);
    }
    c.stroke();
  },
  battery(c, _p, _d, o) {
    line(c, 0, 0, 0, 1.5);
    line(c, 0, 2.5, 0, 4);
    line(c, -0.7, 1.5, 0.7, 1.5);
    line(c, -0.35, 1.95, 0.35, 1.95);
    line(c, -0.7, 2.25, 0.7, 2.25);
    line(c, -0.35, 2.65, 0.35, 2.65);
    text(c, "+", 0.95, 1.2, 11, "center", o.stroke);
  },
  button(c, p) {
    const down = flag(p, "closed");
    line(c, 0, 0, 1, 0);
    line(c, 3, 0, 4, 0);
    circle(c, 1, 0, 0.12, c.strokeStyle as string);
    circle(c, 3, 0, 0.12, c.strokeStyle as string);
    const y = down ? -0.12 : -0.7;
    line(c, 0.8, y, 3.2, y);
    line(c, 2, y, 2, y - 0.7);
    line(c, 1.6, y - 0.7, 2.4, y - 0.7);
  },
  switch(c, p) {
    const closed = flag(p, "closed");
    line(c, 0, 0, 1, 0);
    line(c, 3, 0, 4, 0);
    circle(c, 1, 0, 0.12, c.strokeStyle as string);
    circle(c, 3, 0, 0.12, c.strokeStyle as string);
    if (closed) line(c, 1, 0, 3, 0);
    else line(c, 1, 0, 2.8, -0.95);
  },
  dip_switch: boxSymbol,
  ldr(c) {
    leads2(c, 1, 3);
    rrect(c, 1, -0.4, 2, 0.8, 0);
    c.stroke();
    circle(c, 2, 0, 1.05);
    for (const x of [0.5, 1.1]) {
      line(c, x, -1.8, x + 0.55, -1.0);
      arrowHead(c, x + 0.55, -1.0, Math.PI / 3, 0.2);
    }
  },
  ntc(c, _p, _d, o) {
    thermistor(c, o, "−t°");
  },
  ptc(c, _p, _d, o) {
    thermistor(c, o, "+t°");
  },
  sonar: moduleFace,
  led_rgb: moduleFace,
  sevenseg: moduleFace,
  lcd: moduleFace,
  servo: moduleFace,
  buzzer(c, _p, _d, o) {
    leads2(c, 1.2, 2.8);
    circle(c, 2, 0, 0.8);
    text(c, "♪", 2, 0, 14, "center", o.stroke);
  },
  motor(c, _p, _d, o) {
    leads2(c, 1, 3);
    circle(c, 2, 0, 1);
    text(c, "M", 2, 0, 14, "center", o.stroke);
  },
  relay(c, _p, _d, o) {
    boxSymbol(c, _p, _d, o);
  },
  dmm: moduleFace,
  scope: moduleFace,
  logic: moduleFace,
};

function thermistor(c: C, o: DrawOpts, tag: string): void {
  leads2(c, 1, 3);
  rrect(c, 1, -0.4, 2, 0.8, 0);
  c.stroke();
  line(c, 0.7, 0.9, 1.4, 0.9, 2.6, -0.9);
  text(c, tag, 2, 1.15, 9, "center", o.dim);
}

function bjt(c: C, pnp: boolean): void {
  line(c, 0, 0, 0.8, 0);
  line(c, 0.8, -0.85, 0.8, 0.85);
  const top = pnp ? 2 : -2; // collector y
  const e = pnp ? -2 : 2;
  line(c, 0.8, -0.3 * Math.sign(top), 2, -1 * Math.sign(top), 2, top);
  line(c, 0.8, 0.3 * Math.sign(top), 2, 1 * Math.sign(top), 2, e);
  // arrow on emitter
  const ey = 1 * Math.sign(e);
  if (pnp) arrowHead(c, 1.2, 0.3 * Math.sign(e) + 0.05 * Math.sign(e), Math.atan2(-0.7 * Math.sign(e), -0.4) + Math.PI, 0.28);
  else arrowHead(c, 1.75, ey * 0.85, Math.atan2(0.7, 1.2), 0.28);
}

function mos(c: C, p: boolean): void {
  line(c, 0, 0, 0.7, 0);
  line(c, 0.7, -0.75, 0.7, 0.75);
  for (const [a, b] of [
    [-0.8, -0.4],
    [-0.2, 0.2],
    [0.4, 0.8],
  ] as const)
    line(c, 1.05, a, 1.05, b);
  const d = p ? 2 : -2;
  const s = p ? -2 : 2;
  line(c, 1.05, -0.6 * Math.sign(d), 2, -0.6 * Math.sign(d), 2, d);
  line(c, 1.05, 0.6 * Math.sign(d), 2, 0.6 * Math.sign(d), 2, s);
  line(c, 1.05, 0, 1.6, 0, 1.6, 0.6 * Math.sign(d));
  // body arrow
  if (p) arrowHead(c, 1.05, 0, Math.PI, 0.22);
  else arrowHead(c, 1.05, 0, Math.PI, 0.22);
}

function gate(c: C, fn: "and" | "nand" | "or" | "nor" | "xor" | "not", o: DrawOpts): void {
  const inv = fn === "nand" || fn === "nor" || fn === "not";
  const x0 = 1.4;
  const x1 = inv ? 4.2 : 4.6;
  if (fn === "not") {
    line(c, 0, 0, x0, 0);
    poly(c, true, x0, -1.1, x0, 1.1, x1, 0);
    c.stroke();
  } else {
    line(c, 0, -1, x0 + (fn === "and" || fn === "nand" ? 0 : 0.35), -1);
    line(c, 0, 1, x0 + (fn === "and" || fn === "nand" ? 0 : 0.35), 1);
    if (fn === "and" || fn === "nand") {
      c.beginPath();
      c.moveTo(x0, -1.5);
      c.lineTo(x0 + 1.4, -1.5);
      c.arc(x0 + 1.4, 0, 1.5, -Math.PI / 2, Math.PI / 2);
      c.lineTo(x0, 1.5);
      c.closePath();
      c.stroke();
    } else {
      const off = fn === "xor" ? 0.3 : 0;
      c.beginPath();
      c.moveTo(x0 + off, -1.5);
      c.quadraticCurveTo(x0 + 2.2 + off, -1.4, x0 + 3.2 + off, 0);
      c.quadraticCurveTo(x0 + 2.2 + off, 1.4, x0 + off, 1.5);
      c.quadraticCurveTo(x0 + 0.8 + off, 0, x0 + off, -1.5);
      c.stroke();
      if (fn === "xor") {
        c.beginPath();
        c.moveTo(x0, -1.5);
        c.quadraticCurveTo(x0 + 0.8, 0, x0, 1.5);
        c.stroke();
      }
    }
  }
  if (inv) {
    const bx = fn === "not" ? x1 + 0.2 : x0 + 3.2 + 0.2;
    circle(c, bx, 0, 0.2);
    line(c, bx + 0.2, 0, 6, 0);
  } else {
    line(c, fn === "xor" ? x0 + 3.5 : x0 + 3.2, 0, 6, 0);
  }
  void o;
}

/** Generic rectangular body with pin names — used by ICs, modules and regulators. */
function boxSymbol(c: C, p: PlacedComponent, d: ComponentDef, o: DrawOpts): void {
  const body = d.body ?? [d.bounds[0] + 1, d.bounds[1] + 0.5, d.bounds[2] - 1, d.bounds[3] - 0.5];
  const [x0, y0, x1, y1] = body;
  c.fillStyle = "rgba(255,255,255,0.025)";
  c.fillRect(x0, y0, x1 - x0, y1 - y0);
  c.strokeRect(x0, y0, x1 - x0, y1 - y0);
  for (const pin of d.pins) {
    const left = Math.abs(pin.x - x0) < Math.abs(pin.x - x1);
    const top = pin.y <= y0 - 0.01;
    const bottom = pin.y >= y1 + 0.01;
    if (top) {
      line(c, pin.x, pin.y, pin.x, y0);
      text(c, pin.label, pin.x, y0 + 0.45, 9, "center", o.dim);
    } else if (bottom) {
      line(c, pin.x, pin.y, pin.x, y1);
      text(c, pin.label, pin.x, y1 - 0.45, 9, "center", o.dim);
    } else if (left) {
      line(c, pin.x, pin.y, x0, pin.y);
      text(c, pin.label, x0 + 0.2, pin.y, 9, "left", o.dim);
    } else {
      line(c, pin.x, pin.y, x1, pin.y);
      text(c, pin.label, x1 - 0.2, pin.y, 9, "right", o.dim);
    }
  }
  const title =
    d.kind === "ic555"
      ? "NE555"
      : d.kind.startsWith("reg")
        ? d.kind.replace("reg", "78/79 ").trim()
        : d.kind === "lm317"
          ? "LM317"
          : d.kind === "arduino_uno"
            ? "ARDUINO UNO"
            : d.kind === "esp32"
              ? "ESP32"
              : d.kind === "attiny85"
                ? "ATtiny85"
                : d.kind === "relay"
                  ? "RELAY"
                  : d.kind === "dip_switch"
                    ? "DIP ×4"
                    : d.name.toUpperCase();
  const faceKinds = ["scope", "logic_analyzer", "lcd1602", "sevenseg", "led_rgb", "servo", "hcsr04"];
  if (d.kind === "dmm") text(c, "DIGITAL MULTIMETER", (x0 + x1) / 2, y1 - 0.45, 8, "center", o.dim);
  else if (!faceKinds.includes(d.kind)) text(c, title, (x0 + x1) / 2, (y0 + y1) / 2, 10, "center", o.stroke);
  if (d.kind === "dip_switch") {
    for (let i = 1; i <= 4; i++) {
      const on = flag(p, `s${i}`);
      c.fillStyle = on ? o.accent : "#2a313b";
      c.fillRect(x0 + 0.5, i - 0.2, x1 - x0 - 1, 0.4);
      c.fillStyle = "#d7dde5";
      c.fillRect(on ? x1 - 1.4 : x0 + 0.55, i - 0.17, 0.8, 0.34);
    }
  }
}

/** Parts that have a "face" (instruments, displays) – drawn identically in both views. */
function moduleFace(c: C, p: PlacedComponent, d: ComponentDef, o: DrawOpts): void {
  const body = d.body ?? d.bounds;
  const [x0, y0, x1, y1] = body;
  boxSymbol(c, p, d, { ...o, dim: o.dim });
  switch (d.kind) {
    case "dmm":
      dmmFace(c, p, o, x0, y0, x1, y1);
      break;
    case "scope":
      scopeFace(c, p, o, x0, y0, x1, y1);
      break;
    case "logic_analyzer":
      logicFace(c, p, o, x0, y0, x1, y1);
      break;
    case "lcd1602":
      lcdFace(c, p, o, x0, y0, x1, y1);
      break;
    case "sevenseg":
      sevenSegFace(c, o, x0, y0, x1, y1);
      break;
    case "led_rgb": {
      const r = o.snap?.aux.b_r ?? 0;
      const g = o.snap?.aux.b_g ?? 0;
      const b = o.snap?.aux.b_b ?? 0;
      const cx = (x0 + x1) / 2 + 0.3;
      const cy = (y0 + y1) / 2 + 0.6;
      const col = `rgb(${Math.round(60 + 195 * Math.min(1, r))},${Math.round(60 + 195 * Math.min(1, g))},${Math.round(60 + 195 * Math.min(1, b))})`;
      glow(c, cx, cy, 2.4, col, Math.max(r, g, b));
      circle(c, cx, cy, 0.8, col);
      break;
    }
    case "servo": {
      const ang = (num(p, "angle", 90) - 90) * (Math.PI / 180);
      c.save();
      c.translate(x1 - 1, (y0 + y1) / 2);
      c.rotate(ang);
      c.lineWidth = 0.18;
      line(c, 0, 0, 0, -1.4);
      c.restore();
      circle(c, x1 - 1, (y0 + y1) / 2, 0.3);
      break;
    }
    case "hcsr04":
      circle(c, x0 + 1.5, y0 + 2.5, 1.1);
      circle(c, x1 - 1.5, y0 + 2.5, 1.1);
      circle(c, x0 + 1.5, y0 + 2.5, 0.55);
      circle(c, x1 - 1.5, y0 + 2.5, 0.55);
      break;
    default:
      break;
  }
}

function dmmFace(c: C, p: PlacedComponent, o: DrawOpts, x0: number, y0: number, x1: number, _y1: number): void {
  const mode = str(p, "mode", "voltage");
  const r = o.snap?.aux.reading;
  const overload = o.snap?.aux.overload === 1;
  c.fillStyle = "#0e2a18";
  c.fillRect(x0 + 0.5, y0 + 0.6, x1 - x0 - 1, 2.2);
  c.strokeRect(x0 + 0.5, y0 + 0.6, x1 - x0 - 1, 2.2);
  let s = "----";
  if (r !== undefined) {
    if (overload) s = "OL";
    else if (mode === "voltage") s = formatEng(r, "volt", 4);
    else if (mode === "current") s = formatEng(r, "amp", 4);
    else s = formatEng(r, "ohm", 4);
  }
  text(c, s, (x0 + x1) / 2, y0 + 1.7, 15, "center", "#5dff9a");
  text(c, mode === "voltage" ? "V DC" : mode === "current" ? "A DC" : "Ω", x1 - 0.8, y0 + 0.95, 8, "right", "#5dff9a");
  c.beginPath();
  c.arc((x0 + x1) / 2, y0 + 5.2, 1.3, 0, TAU);
  c.stroke();
  const a = mode === "voltage" ? -0.6 : mode === "current" ? 0.6 : 1.9;
  line(c, (x0 + x1) / 2, y0 + 5.2, (x0 + x1) / 2 + Math.sin(a) * 1.1, y0 + 5.2 - Math.cos(a) * 1.1);
}

function scopeFace(c: C, p: PlacedComponent, o: DrawOpts, x0: number, y0: number, x1: number, y1: number): void {
  const sx = x0 + 1.9;
  const sy = y0 + 0.5;
  const sw = x1 - x0 - 2.3;
  const sh = y1 - y0 - 1;
  drawScopeScreen(c, p, sx, sy, sw, sh, o);
}

/** Shared by the on-canvas scope and (via transform) any other consumer. */
export function drawScopeScreen(c: C, p: PlacedComponent, sx: number, sy: number, sw: number, sh: number, o: Pick<DrawOpts, "accent">): void {
  c.save();
  c.fillStyle = "#06120c";
  c.fillRect(sx, sy, sw, sh);
  c.lineWidth = 0.03;
  c.strokeStyle = "rgba(57,255,136,0.22)";
  for (let i = 0; i <= 10; i++) line(c, sx + (sw * i) / 10, sy, sx + (sw * i) / 10, sy + sh);
  for (let j = 0; j <= 8; j++) line(c, sx, sy + (sh * j) / 8, sx + sw, sy + (sh * j) / 8);
  c.strokeStyle = "rgba(57,255,136,0.5)";
  line(c, sx, sy + sh / 2, sx + sw, sy + sh / 2);
  line(c, sx + sw / 2, sy, sx + sw / 2, sy + sh);
  const buf = probes().get(p.id);
  if (buf && buf.count > 1) {
    const tdiv = num(p, "tdiv", 1e-3);
    const span = tdiv * 10;
    const t1 = buf.at(buf.count - 1).t;
    const t0 = t1 - span;
    const cols = ["#ffe62a", "#2fd8ff"];
    for (let ch = 0; ch < 2; ch++) {
      const vdiv = num(p, ch === 0 ? "vdiv1" : "vdiv2", 1);
      c.strokeStyle = cols[ch]!;
      c.lineWidth = 0.06;
      c.beginPath();
      let started = false;
      for (let i = 0; i < buf.count; i++) {
        const s = buf.at(i);
        if (s.t < t0) continue;
        const x = sx + ((s.t - t0) / span) * sw;
        const y = sy + sh / 2 - (s.v(ch) / vdiv) * (sh / 8);
        const yc = Math.max(sy, Math.min(sy + sh, y));
        if (!started) {
          c.moveTo(x, yc);
          started = true;
        } else c.lineTo(x, yc);
      }
      c.stroke();
    }
  }
  c.strokeStyle = o.accent;
  c.lineWidth = LW;
  c.strokeRect(sx, sy, sw, sh);
  c.restore();
}

function logicFace(c: C, p: PlacedComponent, o: DrawOpts, x0: number, y0: number, x1: number, y1: number): void {
  const sx = x0 + 1.6;
  const sy = y0 + 0.4;
  const sw = x1 - x0 - 2.0;
  const sh = y1 - y0 - 1.4;
  c.fillStyle = "#06120c";
  c.fillRect(sx, sy, sw, sh);
  const buf = probes().get(p.id);
  const th = num(p, "threshold", 1.6);
  if (buf && buf.count > 1) {
    const span = num(p, "tdiv", 1e-3) * 10;
    const t1 = buf.at(buf.count - 1).t;
    const t0 = t1 - span;
    for (let ch = 0; ch < 8; ch++) {
      const base = sy + ((ch + 1) * sh) / 9;
      c.strokeStyle = ["#ff4d5e", "#ffb020", "#ffe62a", "#39ff88", "#2fd8ff", "#4d8dff", "#b38bff", "#ff7ad9"][ch]!;
      c.lineWidth = 0.05;
      c.beginPath();
      let started = false;
      let prevY = 0;
      for (let i = 0; i < buf.count; i++) {
        const s = buf.at(i);
        if (s.t < t0) continue;
        const x = sx + ((s.t - t0) / span) * sw;
        const y = s.v(ch) > th ? base - 0.3 : base + 0.1;
        if (!started) {
          c.moveTo(x, y);
          started = true;
        } else {
          if (y !== prevY) c.lineTo(x, prevY);
          c.lineTo(x, y);
        }
        prevY = y;
      }
      c.stroke();
    }
  }
  c.strokeStyle = o.accent;
  c.lineWidth = LW;
  c.strokeRect(sx, sy, sw, sh);
}

function lcdFace(c: C, p: PlacedComponent, _o: DrawOpts, x0: number, y0: number, x1: number, _y1: number): void {
  c.fillStyle = "#6fa23a";
  c.fillRect(x0 + 1.5, y0 + 1.5, x1 - x0 - 3, 4.5);
  c.fillStyle = "#1e3a10";
  const l1 = str(p, "line1", "").padEnd(16).slice(0, 16);
  const l2 = str(p, "line2", "").padEnd(16).slice(0, 16);
  const cw = (x1 - x0 - 4) / 16;
  [l1, l2].forEach((ln, row) => {
    for (let i = 0; i < 16; i++) {
      const ch = ln[i] ?? " ";
      if (ch === " ") {
        c.fillStyle = "rgba(30,58,16,0.12)";
        c.fillRect(x0 + 2 + i * cw, y0 + 2.2 + row * 1.9, cw * 0.8, 1.4);
      } else text(c, ch, x0 + 2 + i * cw + cw * 0.4, y0 + 2.9 + row * 1.9, 11, "center", "#1e3a10");
    }
  });
}

function sevenSegFace(c: C, o: DrawOpts, x0: number, y0: number, x1: number, _y1: number): void {
  const cx = (x0 + x1) / 2 + 0.2;
  const top = y0 + 1.2;
  const w = 2.2;
  const h = 2.6;
  const seg = (id: string, ax: number, ay: number, bx: number, by: number): void => {
    const b = o.snap?.aux[`b_${id}`] ?? 0;
    c.save();
    c.lineCap = "round";
    c.lineWidth = 0.34;
    c.strokeStyle = b > 0.04 ? `rgba(255,${Math.round(60 + 40 * (1 - Math.min(1, b)))},60,${0.35 + 0.65 * Math.min(1, b)})` : "rgba(255,80,80,0.12)";
    if (b > 0.2) {
      c.shadowColor = "#ff3030";
      c.shadowBlur = 8 * Math.min(1, b);
    }
    line(c, ax, ay, bx, by);
    c.restore();
  };
  const l = cx - w / 2;
  const r = cx + w / 2;
  seg("a", l + 0.25, top, r - 0.25, top);
  seg("b", r, top + 0.25, r, top + h - 0.25);
  seg("c", r, top + h + 0.25, r, top + 2 * h - 0.25);
  seg("d", l + 0.25, top + 2 * h, r - 0.25, top + 2 * h);
  seg("e", l, top + h + 0.25, l, top + 2 * h - 0.25);
  seg("f", l, top + 0.25, l, top + h - 0.25);
  seg("g", l + 0.25, top + h, r - 0.25, top + h);
  const dp = o.snap?.aux.b_dp ?? 0;
  c.fillStyle = dp > 0.04 ? "#ff5050" : "rgba(255,80,80,0.12)";
  c.beginPath();
  c.arc(r + 0.45, top + 2 * h, 0.16, 0, TAU);
  c.fill();
}

// ───────────────────────── physical views ─────────────────────────

type Phys = (c: C, p: PlacedComponent, d: ComponentDef, o: DrawOpts) => void;

function metalLead(c: C, x0: number, y0: number, x1: number, y1: number): void {
  c.save();
  c.strokeStyle = "#aab2bd";
  c.lineWidth = 0.12;
  line(c, x0, y0, x1, y1);
  c.restore();
}

function bodyGradient(c: C, x: number, y: number, w: number, h: number, base: string, hi = "rgba(255,255,255,0.32)"): void {
  c.fillStyle = base;
  c.fill();
  const g = c.createLinearGradient(x, y, x, y + h);
  g.addColorStop(0, hi);
  g.addColorStop(0.45, "rgba(255,255,255,0)");
  g.addColorStop(1, "rgba(0,0,0,0.35)");
  c.fillStyle = g;
  c.fill();
}

const PHYS: Record<string, Phys> = {
  axial(c, p) {
    metalLead(c, 0, 0, 4, 0);
    c.save();
    c.strokeStyle = "rgba(0,0,0,0)";
    rrect(c, 0.95, -0.42, 2.1, 0.84, 0.4);
    bodyGradient(c, 0.95, -0.42, 2.1, 0.84, "#d8c7a0");
    if (p.kind === "resistor") {
      const { bands } = resistanceToBands(num(p, "resistance", 1000), Number(str(p, "tolerance", "5")), false);
      const xs = [1.25, 1.62, 1.99, 2.62];
      bands.forEach((b, i) => {
        c.fillStyle = b.hex;
        c.fillRect(xs[i]!, -0.42, 0.18, 0.84);
      });
    }
    c.restore();
  },
  ceramic(c, p) {
    metalLead(c, 0, 0, 1.7, 0);
    metalLead(c, 2.3, 0, 4, 0);
    c.beginPath();
    c.ellipse(2, 0, 0.45, 0.8, 0, 0, TAU);
    bodyGradient(c, 1.5, -0.8, 1, 1.6, p.kind === "cap_ceramic" ? "#c9892f" : "#7a5a3a");
    text(c, p.kind === "cap_ceramic" ? formatEng(num(p, "capacitance", 1e-7), "farad", 2) : "", 2, 0, 8, "center", "#2a1a08");
  },
  electrolytic(c, p) {
    metalLead(c, 0, 0, 1, 0);
    metalLead(c, 3, 0, 4, 0);
    rrect(c, 1, -0.75, 2, 1.5, 0.15);
    bodyGradient(c, 1, -0.75, 2, 1.5, "#1b4fa8");
    c.fillStyle = "#e8edf5";
    c.fillRect(2.65, -0.75, 0.3, 1.5);
    text(c, `${formatEng(num(p, "capacitance", 1e-4), "farad", 2)}`, 1.8, 0, 8, "center", "#e8edf5");
  },
  tantalum(c, p) {
    metalLead(c, 0, 0, 1.1, 0);
    metalLead(c, 2.9, 0, 4, 0);
    rrect(c, 1.1, -0.6, 1.8, 1.2, 0.5);
    bodyGradient(c, 1.1, -0.6, 1.8, 1.2, "#e0a516");
    c.fillStyle = "#3a2a00";
    c.fillRect(1.2, -0.6, 0.2, 1.2);
    text(c, formatEng(num(p, "capacitance", 1e-5), "farad", 2), 2.2, 0, 8, "center", "#3a2a00");
  },
  coil(c) {
    metalLead(c, 0, 0, 0.8, 0);
    metalLead(c, 3.2, 0, 4, 0);
    c.save();
    c.lineWidth = 0.22;
    for (let i = 0; i < 8; i++) {
      c.strokeStyle = i % 2 ? "#a15a1f" : "#d9833a";
      c.beginPath();
      c.arc(1.1 + i * 0.26, 0, 0.5, Math.PI * 1.1, Math.PI * 2.1);
      c.stroke();
    }
    c.restore();
  },
  transformer(c) {
    c.fillStyle = "#2b2f36";
    c.fillRect(0.6, 0.2, 2.8, 3.6);
    c.fillStyle = "#3a4048";
    c.fillRect(0.9, 0.5, 2.2, 3);
    c.fillStyle = "#b9722e";
    c.fillRect(1.1, 0.8, 0.9, 2.4);
    c.fillRect(2, 0.8, 0.9, 2.4);
    for (const [x, y] of [[0, 0], [0, 4], [4, 0], [4, 4]] as const) metalLead(c, x, y, x < 2 ? 0.6 : 3.4, y < 2 ? 0.2 : 3.8);
  },
  pot(c, p) {
    metalLead(c, 0, 0, 0.8, 0);
    metalLead(c, 3.2, 0, 4, 0);
    metalLead(c, 2, 2, 2, 0.5);
    c.beginPath();
    c.arc(2, 0, 1.15, 0, TAU);
    bodyGradient(c, 0.85, -1.15, 2.3, 2.3, "#25508f");
    c.beginPath();
    c.arc(2, 0, 0.55, 0, TAU);
    bodyGradient(c, 1.45, -0.55, 1.1, 1.1, "#b9c0ca");
    const a = (-135 + 270 * (num(p, "wiper", 50) / 100)) * (Math.PI / 180);
    c.strokeStyle = "#1a1d22";
    c.lineWidth = 0.12;
    line(c, 2, 0, 2 + Math.cos(a - Math.PI / 2) * 0.5, Math.sin(a - Math.PI / 2) * 0.5);
  },
  diode(c, p) {
    metalLead(c, 0, 0, 4, 0);
    rrect(c, 1.1, -0.4, 1.8, 0.8, 0.2);
    bodyGradient(c, 1.1, -0.4, 1.8, 0.8, p.kind === "zener" ? "#3b6e82" : "#1b1b1f");
    c.fillStyle = "#e4e4e4";
    c.fillRect(2.55, -0.4, 0.2, 0.8);
  },
  led(c, p, _d, o) {
    const col = LED_RGB_HEX[str(p, "color", "red")] ?? "#ff2a2a";
    const b = o.snap?.aux.brightness ?? 0;
    metalLead(c, 0, 0, 1.4, 0);
    metalLead(c, 2.6, 0, 4, 0);
    glow(c, 2, 0, 2.6, col, Math.min(1, b));
    c.beginPath();
    c.arc(2, 0, 0.85, 0, TAU);
    c.fillStyle = b > 0.02 ? col : "rgba(120,120,120,0.35)";
    c.globalAlpha = b > 0.02 ? 0.55 + 0.45 * Math.min(1, b) : 1;
    c.fill();
    c.globalAlpha = 1;
    c.fillStyle = "rgba(255,255,255,0.35)";
    c.beginPath();
    c.ellipse(1.7, -0.3, 0.22, 0.14, -0.6, 0, TAU);
    c.fill();
    void LED_VF;
  },
  to92(c, _p, d) {
    c.beginPath();
    c.moveTo(0.2, -1.6);
    c.arc(1.1, -0.4, 1.0, Math.PI, 0);
    c.lineTo(2.0, 1.6);
    c.lineTo(0.2, 1.6);
    c.closePath();
    bodyGradient(c, 0.2, -1.4, 1.8, 3, "#1a1a1d");
    for (const pin of d.pins) metalLead(c, pin.x, pin.y, 1.1, pin.y);
  },
  to220(c, _p, d) {
    c.fillStyle = "#9ea6b0";
    c.fillRect(0.7, -2.4, 1.3, 1.1);
    c.fillStyle = "#1a1a1d";
    c.fillRect(0.7, -1.3, 1.3, 2.6);
    c.fillStyle = "#2a2a30";
    c.fillRect(0.7, 1.3, 1.3, 0.7);
    for (const pin of d.pins) metalLead(c, pin.x, pin.y, 1.6, pin.y);
  },
  dip(c, p, d, o) {
    const [x0, y0, x1, y1] = d.body ?? d.bounds;
    c.fillStyle = "#c0c6ce";
    for (const pin of d.pins) {
      const left = Math.abs(pin.x - x0) < Math.abs(pin.x - x1);
      if (left) c.fillRect(pin.x, pin.y - 0.14, x0 - pin.x + 0.1, 0.28);
      else c.fillRect(x1 - 0.1, pin.y - 0.14, pin.x - x1 + 0.1, 0.28);
    }
    rrect(c, x0, y0, x1 - x0, y1 - y0, 0.15);
    bodyGradient(c, x0, y0, x1 - x0, y1 - y0, "#17181b", "rgba(255,255,255,0.14)");
    c.fillStyle = "#050506";
    c.beginPath();
    c.arc((x0 + x1) / 2, y0, 0.28, 0, Math.PI);
    c.fill();
    text(c, d.name.replace(/ ·.*/, "").toUpperCase(), (x0 + x1) / 2, (y0 + y1) / 2, 9, "center", "#8b929c");
    void p;
    void o;
  },
  module(c, p, d, o) {
    const [x0, y0, x1, y1] = d.body ?? d.bounds;
    const green = d.kind === "arduino_uno" ? "#0b6d78" : d.kind === "esp32" ? "#16181c" : d.category === "instrument" ? "#2b3340" : "#24402c";
    rrect(c, x0, y0, x1 - x0, y1 - y0, 0.25);
    bodyGradient(c, x0, y0, x1 - x0, y1 - y0, green, "rgba(255,255,255,0.12)");
    c.fillStyle = "#c9a227";
    for (const pin of d.pins) {
      c.beginPath();
      c.arc(Math.abs(pin.x - x0) < Math.abs(pin.x - x1) ? x0 + 0.2 : x1 - 0.2, pin.y, 0.14, 0, TAU);
      if (pin.y < y0 || pin.y > y1) c.arc(pin.x, y1 - 0.2, 0.14, 0, TAU);
      c.fill();
    }
    for (const pin of d.pins) {
      const left = Math.abs(pin.x - x0) < Math.abs(pin.x - x1);
      c.save();
      c.strokeStyle = "#c9a227";
      c.lineWidth = 0.1;
      if (pin.y > y1) line(c, pin.x, pin.y, pin.x, y1);
      else if (left) line(c, pin.x, pin.y, x0, pin.y);
      else line(c, pin.x, pin.y, x1, pin.y);
      c.restore();
    }
    text(c, d.name.toUpperCase(), (x0 + x1) / 2, y0 + 0.5, 9, "center", "#d8e2f0");
    void p;
    void o;
  },
  battery(c, p, _d, o) {
    line(c, 0, 0, 0, 1);
    line(c, 0, 3, 0, 4);
    rrect(c, -0.8, 1, 1.6, 2, 0.15);
    bodyGradient(c, -0.8, 1, 1.6, 2, p.kind === "battery_lipo" ? "#2a5a9c" : p.kind === "battery_aa" ? "#2a2c30" : "#1c1d20");
    c.fillStyle = p.kind === "battery_aa" ? "#d6a41a" : "#d4a01c";
    c.fillRect(-0.8, 1.25, 1.6, 0.35);
    text(c, formatEng(num(p, "voltage", 5), "volt", 2), 0, 2.4, 10, "center", "#e8edf5");
    void o;
  },
  switch(c, p) {
    metalLead(c, 0, 0, 4, 0);
    rrect(c, 1, -0.6, 2, 1.2, 0.2);
    bodyGradient(c, 1, -0.6, 2, 1.2, "#2a2d34");
    if (p.kind === "pushbutton") {
      c.beginPath();
      c.arc(2, flag(p, "closed") ? -0.15 : -0.35, 0.5, 0, TAU);
      bodyGradient(c, 1.5, -0.85, 1, 1, "#c0392b");
    } else {
      c.save();
      c.translate(2, 0);
      c.rotate(flag(p, "closed") ? -0.5 : 0.5);
      c.fillStyle = "#c9d0da";
      c.fillRect(-0.12, -1.3, 0.24, 1.3);
      c.restore();
    }
  },
  generic(c, p, d, o) {
    SCHEM[d.symbol]?.(c, p, d, o);
  },
};

// ───────────────────────── entry point ─────────────────────────

export function drawComponent(c: C, p: PlacedComponent, d: ComponentDef, o: DrawOpts): void {
  ORIENT = { rot: o.rotation, mirror: o.mirror };
  c.save();
  c.lineWidth = LW;
  c.lineCap = "round";
  c.lineJoin = "round";
  c.strokeStyle = o.stroke;
  c.fillStyle = o.stroke;

  const physical = o.view === "physical" && !!PHYS[d.pkg] && d.pkg !== "generic";
  // Displays/instruments always show their face; the physical body is just the module panel.
  if (physical) {
    PHYS[d.pkg]!(c, p, d, o);
    if (["dmm", "scope", "logic_analyzer", "lcd1602", "sevenseg", "led_rgb", "servo", "hcsr04"].includes(d.kind)) {
      moduleFace(c, p, d, { ...o, stroke: o.stroke });
    }
  } else {
    (SCHEM[d.symbol] ?? boxSymbol)(c, p, d, o);
    if (d.kind === "led") {
      const b = o.snap?.aux.brightness ?? 0;
      glow(c, 2, 0, 2.2, LED_RGB_HEX[str(p, "color", "red")] ?? "#ff2a2a", Math.min(1, b) * 0.9);
    }
  }
  c.restore();
}

export const BAND_PALETTE = BAND_COLORS;
export const GRID_SIZE = GRID;
