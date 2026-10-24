/** Oscilloscope maths: configuration, trigger search, measurements and auto-set. Pure and testable. */

import type { ProbeBuffer } from "./devices";

export type Coupling = "dc" | "ac" | "gnd";

export interface ScopeCfg {
  tdiv: number;
  vdiv: [number, number];
  /** vertical position in divisions */
  pos: [number, number];
  cpl: [Coupling, Coupling];
  on: [boolean, boolean];
  trigSrc: 0 | 1;
  trigRising: boolean;
  /** auto: free-runs when no trigger arrives; normal: holds the last triggered sweep */
  trigAuto: boolean;
  autoLevel: boolean;
  level: number;
  math: "off" | "add" | "sub" | "mul";
  xy: boolean;
}

type P = Record<string, number | string | boolean>;
const numOr = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

export function cfgFromParams(p: P): ScopeCfg {
  const cpl = (v: unknown): Coupling => (v === "ac" || v === "gnd" ? v : "dc");
  const math = p.math === "add" || p.math === "sub" || p.math === "mul" ? p.math : "off";
  return {
    tdiv: Math.max(1e-9, numOr(p.tdiv, 1e-3)),
    vdiv: [Math.max(1e-6, numOr(p.vdiv1, 1)), Math.max(1e-6, numOr(p.vdiv2, 1))],
    pos: [numOr(p.pos1, 0), numOr(p.pos2, 0)],
    cpl: [cpl(p.cpl1), cpl(p.cpl2)],
    on: [p.on1 !== false, p.on2 !== false],
    trigSrc: p.trigSrc === "ch2" ? 1 : 0,
    trigRising: p.trigEdge !== "fall",
    trigAuto: p.trigMode !== "normal",
    autoLevel: p.autoLevel !== false,
    level: numOr(p.trigger, 0),
    math,
    xy: p.display === "xy",
  };
}

export interface Sweep {
  /** time at the left edge of the screen */
  t0: number;
  span: number;
  triggered: boolean;
  /** trigger level actually used (V, before position offset) */
  level: number;
  /** time of the trigger event */
  tTrig: number;
}

/** Fraction of the screen that precedes the trigger point. */
export const PRETRIGGER = 0.1;

interface Range {
  i0: number;
  i1: number; // exclusive
}

export function windowRange(buf: ProbeBuffer, t0: number, span: number): Range {
  const i0 = buf.lowerBound(t0);
  const i1 = buf.lowerBound(t0 + span + 1e-15);
  return { i0, i1 };
}

function lookback(buf: ProbeBuffer, ch: number, i0: number, i1: number): { lo: number; hi: number; mean: number } {
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  let n = 0;
  const a = buf.ch[ch]!;
  for (let i = i0; i < i1; i++) {
    const v = a[buf.idx(i)]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
    sum += v;
    n++;
  }
  return { lo, hi, mean: n ? sum / n : 0 };
}

/**
 * Pick the sweep to display. The latest trigger event that leaves a full post-trigger screen of data wins; with
 * AC coupling on the trigger source the level is relative to the signal's mean.
 */
export function findSweep(buf: ProbeBuffer, cfg: ScopeCfg): Sweep | null {
  if (buf.count < 2) return null;
  const span = cfg.tdiv * 10;
  const tNow = buf.timeAt(buf.count - 1);
  const free: Sweep = { t0: tNow - span, span, triggered: false, level: 0, tTrig: -Infinity };

  const src = cfg.trigSrc;
  // statistics over the last two screens of the trigger source
  const rA = buf.lowerBound(tNow - 2 * span);
  const st = lookback(buf, src, rA, buf.count);
  const swing = st.hi - st.lo;
  if (!(swing > 1e-6)) return { ...free, level: st.mean };
  const level = cfg.autoLevel ? (st.hi + st.lo) / 2 : cfg.level + (cfg.cpl[src] === "ac" ? st.mean : 0);
  const hyst = Math.max(swing * 0.03, 1e-9);
  const limit = tNow - span * (1 - PRETRIGGER);
  const a = buf.ch[src]!;
  let iEnd = buf.lowerBound(limit);
  if (iEnd >= buf.count) iEnd = buf.count - 1;
  // scan backwards for the most recent qualifying edge
  let found = -1;
  const iStop = Math.max(1, buf.lowerBound(tNow - 6 * span));
  for (let i = iEnd; i >= iStop; i--) {
    const v1 = a[buf.idx(i)]!;
    const v0 = a[buf.idx(i - 1)]!;
    const hit = cfg.trigRising ? v0 < level && v1 >= level : v0 > level && v1 <= level;
    if (!hit) continue;
    // require that the signal really came from the other side of the hysteresis band
    let armed = false;
    for (let k = i - 1; k >= Math.max(0, i - 400); k--) {
      const vk = a[buf.idx(k)]!;
      if (cfg.trigRising ? vk < level - hyst : vk > level + hyst) {
        armed = true;
        break;
      }
      if (cfg.trigRising ? vk > level + hyst : vk < level - hyst) break;
    }
    if (!armed) continue;
    found = i;
    break;
  }
  if (found < 0) {
    if (cfg.trigAuto) return { ...free, level };
    // normal mode: keep showing the previous triggered sweep while it is still in the buffer
    if (buf.lastTrig > buf.timeAt(0)) {
      const t0 = buf.lastTrig - span * PRETRIGGER;
      return { t0, span, triggered: true, level, tTrig: buf.lastTrig };
    }
    return null;
  }
  const i = found;
  const t0s = buf.timeAt(i - 1);
  const t1s = buf.timeAt(i);
  const v0 = a[buf.idx(i - 1)]!;
  const v1 = a[buf.idx(i)]!;
  const f = v1 === v0 ? 1 : (level - v0) / (v1 - v0);
  const tTrig = t0s + Math.min(1, Math.max(0, f)) * (t1s - t0s);
  buf.lastTrig = tTrig;
  return { t0: tTrig - span * PRETRIGGER, span, triggered: true, level, tTrig };
}

/** Memoised `findSweep` (the canvas asks every frame; the answer only changes when new samples arrive). */
export function cachedSweep(buf: ProbeBuffer, cfg: ScopeCfg): Sweep | null {
  const key = `${buf.lastT}|${buf.count}|${cfg.tdiv}|${cfg.trigSrc}|${cfg.trigRising}|${cfg.trigAuto}|${cfg.autoLevel}|${cfg.level}|${cfg.cpl[cfg.trigSrc]}`;
  if (buf.memo && buf.memo.key === key) return buf.memo.value as Sweep | null;
  const v = findSweep(buf, cfg);
  buf.memo = { key, value: v };
  return v;
}

export interface Measure {
  n: number;
  vmin: number;
  vmax: number;
  vpp: number;
  mean: number;
  rms: number;
  /** AC-coupled rms (rms about the mean) */
  rmsAc: number;
  freq: number | null;
}

/** Statistics of channel `ch` (0/1) or a derived series between sample indices [i0, i1). */
export function measure(buf: ProbeBuffer, series: (idx: number) => number, i0: number, i1: number): Measure | null {
  const n = i1 - i0;
  if (n < 1) return null;
  let vmin = Infinity;
  let vmax = -Infinity;
  let sum = 0;
  let sumSq = 0;
  const vs: number[] = new Array<number>(n);
  const ts: number[] = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    const idx = buf.idx(i0 + i);
    const v = series(idx);
    vs[i] = v;
    ts[i] = buf.t[idx]!;
    if (v < vmin) vmin = v;
    if (v > vmax) vmax = v;
    sum += v;
    sumSq += v * v;
  }
  const mean = sum / n;
  const swing = vmax - vmin;
  let freq: number | null = null;
  if (swing > 1e-6 && n > 3) {
    const mid = (vmax + vmin) / 2;
    const hyst = swing * 0.05;
    let armed = vs[0]! < mid - hyst;
    const cross: number[] = [];
    for (let i = 1; i < n; i++) {
      if (armed && vs[i]! >= mid + hyst) {
        const d = vs[i]! - vs[i - 1]!;
        const f = d === 0 ? 1 : (mid - vs[i - 1]!) / d;
        cross.push(ts[i - 1]! + Math.min(1, Math.max(0, f)) * (ts[i]! - ts[i - 1]!));
        armed = false;
      } else if (vs[i]! < mid - hyst) armed = true;
    }
    if (cross.length >= 2) freq = (cross.length - 1) / (cross[cross.length - 1]! - cross[0]!);
  }
  return {
    n,
    vmin,
    vmax,
    vpp: swing,
    mean,
    rms: Math.sqrt(sumSq / n),
    rmsAc: Math.sqrt(Math.max(0, sumSq / n - mean * mean)),
    freq,
  };
}

/** 1-2-5 ladder helpers */
const LADDER = [1, 2, 5];
export function niceUp(x: number): number {
  if (!(x > 0)) return 1;
  const e = Math.floor(Math.log10(x));
  const base = 10 ** e;
  for (const m of LADDER) if (m * base >= x * 0.9999) return m * base;
  return 10 * base;
}

export function ladder(min: number, max: number): number[] {
  const out: number[] = [];
  const e0 = Math.floor(Math.log10(min));
  const e1 = Math.ceil(Math.log10(max));
  for (let e = e0; e <= e1; e++) {
    for (const m of LADDER) {
      const v = Number((m * 10 ** e).toPrecision(3));
      if (v >= min * 0.999 && v <= max * 1.001) out.push(v);
    }
  }
  return out;
}

/** "Autoset": choose time base, volts/div and position so the signals fill the screen. */
export function autoSet(buf: ProbeBuffer, cfg: ScopeCfg): Record<string, number | string> {
  const patch: Record<string, number | string> = {};
  if (buf.count < 8) return patch;
  const tNow = buf.timeAt(buf.count - 1);
  // use the most recent chunk (up to 4 screens, at least what is there)
  const from = buf.lowerBound(tNow - cfg.tdiv * 40);
  let freq: number | null = null;
  for (const ch of [0, 1]) {
    const m = measure(buf, (idx) => buf.ch[ch]![idx]!, from, buf.count);
    if (m?.freq && (freq === null || ch === 0)) freq = m.freq;
  }
  let tdiv = cfg.tdiv;
  if (freq) tdiv = niceUp(2.5 / freq / 10);
  patch.tdiv = tdiv;
  const refFrom = buf.lowerBound(tNow - tdiv * 20);
  for (const ch of [0, 1]) {
    const m = measure(buf, (idx) => buf.ch[ch]![idx]!, Math.max(refFrom, 0), buf.count);
    if (!m) continue;
    const vpp = m.vpp;
    const vdiv = vpp > 1e-6 ? niceUp(vpp / 6) : niceUp(Math.max(Math.abs(m.mean) / 3, 0.001));
    patch[ch === 0 ? "vdiv1" : "vdiv2"] = vdiv;
    const centre = vpp > 1e-6 ? (m.vmax + m.vmin) / 2 : m.mean;
    const pos = -centre / vdiv;
    if (vpp > 1e-6 && Math.abs(pos) > 3.2) {
      // a small ripple riding on a large DC level: AC coupling brings it back on screen
      patch[ch === 0 ? "cpl1" : "cpl2"] = "ac";
      patch[ch === 0 ? "pos1" : "pos2"] = 0;
    } else {
      patch[ch === 0 ? "cpl1" : "cpl2"] = "dc";
      patch[ch === 0 ? "pos1" : "pos2"] = Number(pos.toFixed(2));
    }
  }
  return patch;
}

/** Value of the coupled series for display: (v − dc) / vdiv + pos, in divisions. */
export function toDivisions(v: number, dcOffset: number, cfg: ScopeCfg, ch: 0 | 1): number {
  if (cfg.cpl[ch] === "gnd") return cfg.pos[ch];
  return (v - dcOffset) / cfg.vdiv[ch] + cfg.pos[ch];
}
