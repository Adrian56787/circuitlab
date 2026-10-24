/** Shared oscilloscope renderer: used by the Instruments dock (1 unit = 1 CSS px) and the on-canvas symbol. */

import type { ProbeBuffer } from "@/engine/devices";
import {
  PRETRIGGER,
  cachedSweep,
  measure,
  toDivisions,
  windowRange,
  type Measure,
  type ScopeCfg,
  type Sweep,
} from "@/engine/scopeMath";
import { formatEng } from "@/models/units";

export const CH_COLORS = ["#ffe62a", "#2fd8ff"] as const;
export const MATH_COLOR = "#ff7ad9";

export interface ScopeDrawOpts {
  /** size of one screen pixel in drawing units */
  unit: number;
  /** draw the legend strip and hover read-out */
  labels: boolean;
  /** horizontal hover position as a fraction of the screen width, or null */
  hover: number | null;
  /** use this sweep instead of the live trigger (RUN/STOP) */
  frozen: Sweep | null;
  accent?: string;
}

export interface HoverInfo {
  /** time relative to the trigger point (or the left edge when untriggered) */
  t: number;
  v: [number | null, number | null];
}

export interface ScopeDrawResult {
  sweep: Sweep | null;
  measures: [Measure | null, Measure | null, Measure | null];
  hover: HoverInfo | null;
}

type Ctx = CanvasRenderingContext2D;

function graticule(c: Ctx, x: number, y: number, w: number, h: number, u: number, xy: boolean): void {
  c.fillStyle = "#04100a";
  c.fillRect(x, y, w, h);
  c.lineWidth = u;
  c.strokeStyle = "rgba(57,255,136,0.16)";
  c.beginPath();
  for (let i = 1; i < 10; i++) {
    const px = x + Math.round((w * i) / 10 / u) * u + 0.5 * u;
    c.moveTo(px, y);
    c.lineTo(px, y + h);
  }
  for (let j = 1; j < 8; j++) {
    const py = y + Math.round((h * j) / 8 / u) * u + 0.5 * u;
    c.moveTo(x, py);
    c.lineTo(x + w, py);
  }
  c.stroke();
  // centre axes with minor ticks
  c.strokeStyle = "rgba(57,255,136,0.42)";
  c.beginPath();
  c.moveTo(x, y + h / 2);
  c.lineTo(x + w, y + h / 2);
  c.moveTo(x + w / 2, y);
  c.lineTo(x + w / 2, y + h);
  c.stroke();
  c.strokeStyle = "rgba(57,255,136,0.32)";
  c.beginPath();
  const tick = 2.2 * u;
  for (let i = 0; i <= 50; i++) {
    const px = x + (w * i) / 50;
    c.moveTo(px, y + h / 2 - tick);
    c.lineTo(px, y + h / 2 + tick);
  }
  for (let j = 0; j <= 40; j++) {
    const py = y + (h * j) / 40;
    c.moveTo(x + w / 2 - tick, py);
    c.lineTo(x + w / 2 + tick, py);
  }
  c.stroke();
  void xy;
}

/** Draw one trace. `val` gives the (already coupled) value for a ring index, `lo/hi` an optional envelope. */
function trace(
  c: Ctx,
  buf: ProbeBuffer,
  i0: number,
  i1: number,
  sweep: Sweep,
  rect: { x: number; y: number; w: number; h: number },
  u: number,
  color: string,
  toY: (idx: number, which: "v" | "lo" | "hi") => number,
  hasEnv: boolean,
): void {
  const { x, y, w, h } = rect;
  const n = i1 - i0;
  if (n < 1) return;
  const cols = Math.max(2, Math.floor(w / u));
  const xOf = (t: number): number => x + ((t - sweep.t0) / sweep.span) * w;
  const a = Math.max(0, i0 - 1);
  const b = Math.min(buf.count, i1 + 1);
  c.save();
  c.beginPath();
  c.rect(x, y, w, h);
  c.clip();
  const draw = (lw: number, alpha: number): void => {
    c.lineJoin = "round";
    c.lineCap = "round";
    c.strokeStyle = color;
    c.globalAlpha = alpha;
    c.lineWidth = lw;
    c.stroke();
  };
  c.beginPath();
  if (b - a <= cols * 1.4) {
    let first = true;
    for (let i = a; i < b; i++) {
      const idx = buf.idx(i);
      const px = xOf(buf.t[idx]!);
      const py = y + h / 2 - toY(idx, "v");
      if (first) {
        c.moveTo(px, py);
        first = false;
      } else c.lineTo(px, py);
    }
  } else {
    // more samples than pixels: per-column first / min / max / last keeps every glitch visible
    const first = new Float32Array(cols).fill(NaN);
    const last = new Float32Array(cols).fill(NaN);
    const mn = new Float32Array(cols).fill(Infinity);
    const mx = new Float32Array(cols).fill(-Infinity);
    for (let i = a; i < b; i++) {
      const idx = buf.idx(i);
      const col = Math.floor(((buf.t[idx]! - sweep.t0) / sweep.span) * cols);
      if (col < 0 || col >= cols) continue;
      const yv = toY(idx, "v");
      const ylo = hasEnv ? toY(idx, "lo") : yv;
      const yhi = hasEnv ? toY(idx, "hi") : yv;
      if (Number.isNaN(first[col]!)) first[col] = yv;
      last[col] = yv;
      mn[col] = Math.min(mn[col]!, ylo, yhi);
      mx[col] = Math.max(mx[col]!, ylo, yhi);
    }
    let started = false;
    for (let col = 0; col < cols; col++) {
      if (Number.isNaN(first[col]!)) continue;
      const px = x + ((col + 0.5) / cols) * w;
      const f = y + h / 2 - first[col]!;
      const l = y + h / 2 - last[col]!;
      const lo = y + h / 2 - mx[col]!; // note: screen y grows downward
      const hi = y + h / 2 - mn[col]!;
      if (!started) {
        c.moveTo(px, f);
        started = true;
      } else c.lineTo(px, f);
      if (hi - lo > 0.5 * u) {
        // go to the nearer extreme first so the path does not zig-zag
        if (Math.abs(f - lo) < Math.abs(f - hi)) {
          c.lineTo(px, lo);
          c.lineTo(px, hi);
        } else {
          c.lineTo(px, hi);
          c.lineTo(px, lo);
        }
      }
      c.lineTo(px, l);
    }
  }
  draw(4.2 * u, 0.16); // glow
  draw(1.6 * u, 1);
  c.restore();
}

function markers(
  c: Ctx,
  rect: { x: number; y: number; w: number; h: number },
  u: number,
  cfg: ScopeCfg,
  sweep: Sweep | null,
  dcs: [number, number],
): void {
  const { x, y, w, h } = rect;
  const row = (d: number): number => y + h / 2 - d * (h / 8);
  const s = 5 * u;
  // channel ground markers on the left edge
  for (const ch of [0, 1] as const) {
    if (!cfg.on[ch]) continue;
    const py = row(cfg.pos[ch] + (cfg.cpl[ch] === "gnd" ? 0 : 0));
    if (py < y - s || py > y + h + s) continue;
    c.fillStyle = CH_COLORS[ch];
    c.beginPath();
    c.moveTo(x, py - s);
    c.lineTo(x + s * 1.6, py);
    c.lineTo(x, py + s);
    c.closePath();
    c.fill();
    c.fillStyle = "#04100a";
    c.font = `${7.5 * u}px ui-monospace, monospace`;
    c.textAlign = "left";
    c.textBaseline = "middle";
    c.fillText(String(ch + 1), x + 0.8 * u, py);
  }
  if (sweep && !cfg.xy) {
    // trigger level marker (right edge) and trigger position marker (top)
    const ch = cfg.trigSrc;
    const py = row(toDivisions(sweep.level, dcs[ch], cfg, ch));
    if (py >= y && py <= y + h) {
      c.fillStyle = CH_COLORS[ch];
      c.beginPath();
      c.moveTo(x + w, py - s * 0.8);
      c.lineTo(x + w - s * 1.4, py);
      c.lineTo(x + w, py + s * 0.8);
      c.closePath();
      c.fill();
    }
    const tx = x + w * PRETRIGGER;
    c.fillStyle = sweep.triggered ? "#ff9d2e" : "rgba(255,157,46,0.35)";
    c.beginPath();
    c.moveTo(tx - s * 0.8, y);
    c.lineTo(tx + s * 0.8, y);
    c.lineTo(tx, y + s * 1.2);
    c.closePath();
    c.fill();
  }
}

export function drawScope(
  c: Ctx,
  x: number,
  y: number,
  w: number,
  h: number,
  cfg: ScopeCfg,
  buf: ProbeBuffer | undefined,
  o: ScopeDrawOpts,
): ScopeDrawResult {
  const u = o.unit;
  const rect = { x, y, w, h };
  graticule(c, x, y, w, h, u, cfg.xy);
  const result: ScopeDrawResult = { sweep: null, measures: [null, null, null], hover: null };

  c.save();
  const message = (text: string): void => {
    c.fillStyle = "rgba(57,255,136,0.6)";
    c.font = `${11 * u}px ui-monospace, monospace`;
    c.textAlign = "center";
    c.textBaseline = "middle";
    c.fillText(text, x + w / 2, y + h / 2);
  };
  if (!buf || buf.count < 2) {
    message("NO DATA — RUN THE SIMULATION");
    c.restore();
    c.strokeStyle = o.accent ?? "#39ff88";
    c.lineWidth = u;
    c.strokeRect(x, y, w, h);
    return result;
  }

  let sweep = o.frozen ?? cachedSweep(buf, cfg);
  if (cfg.xy && !o.frozen) {
    const tNow = buf.timeAt(buf.count - 1);
    sweep = { t0: tNow - cfg.tdiv * 10, span: cfg.tdiv * 10, triggered: false, level: 0, tTrig: -Infinity };
  }
  result.sweep = sweep;
  if (!sweep) {
    message("WAITING FOR TRIGGER");
    c.restore();
    c.strokeStyle = o.accent ?? "#39ff88";
    c.lineWidth = u;
    c.strokeRect(x, y, w, h);
    return result;
  }

  const { i0, i1 } = windowRange(buf, sweep.t0, sweep.span);
  const ms: [Measure | null, Measure | null] = [
    measure(buf, (i) => buf.ch[0]![i]!, i0, i1),
    measure(buf, (i) => buf.ch[1]![i]!, i0, i1),
  ];
  const mathFn = (idx: number): number => {
    const a = buf.ch[0]![idx]!;
    const b = buf.ch[1]![idx]!;
    return cfg.math === "add" ? a + b : cfg.math === "sub" ? a - b : a * b;
  };
  const mm = cfg.math !== "off" ? measure(buf, mathFn, i0, i1) : null;
  result.measures = [ms[0], ms[1], mm];
  // AC coupling removes the mean of the visible window
  const dcs: [number, number] = [cfg.cpl[0] === "ac" ? (ms[0]?.mean ?? 0) : 0, cfg.cpl[1] === "ac" ? (ms[1]?.mean ?? 0) : 0];
  const divPx = h / 8;

  if (cfg.xy) {
    // Lissajous: CH1 on X, CH2 on Y
    c.save();
    c.beginPath();
    c.rect(x, y, w, h);
    c.clip();
    c.beginPath();
    let first = true;
    for (let i = Math.max(0, i0 - 1); i < Math.min(buf.count, i1 + 1); i++) {
      const idx = buf.idx(i);
      const dx = toDivisions(buf.ch[0]![idx]!, dcs[0], cfg, 0);
      const dy = toDivisions(buf.ch[1]![idx]!, dcs[1], cfg, 1);
      const px = x + w / 2 + dx * (w / 10);
      const py = y + h / 2 - dy * divPx;
      if (first) {
        c.moveTo(px, py);
        first = false;
      } else c.lineTo(px, py);
    }
    c.lineJoin = "round";
    c.strokeStyle = "#39ff88";
    c.globalAlpha = 0.16;
    c.lineWidth = 4.2 * u;
    c.stroke();
    c.globalAlpha = 1;
    c.lineWidth = 1.5 * u;
    c.stroke();
    c.restore();
  } else {
    for (const ch of [0, 1] as const) {
      if (!cfg.on[ch]) continue;
      if (cfg.cpl[ch] === "gnd") {
        const py = y + h / 2 - cfg.pos[ch] * divPx;
        c.strokeStyle = CH_COLORS[ch];
        c.lineWidth = 1.4 * u;
        c.beginPath();
        c.moveTo(x, py);
        c.lineTo(x + w, py);
        c.stroke();
        continue;
      }
      trace(
        c,
        buf,
        i0,
        i1,
        sweep,
        rect,
        u,
        CH_COLORS[ch],
        (idx, which) => {
          const arr = which === "v" ? buf.ch[ch]! : which === "lo" ? buf.lo[ch]! : buf.hi[ch]!;
          return toDivisions(arr[idx]!, dcs[ch], cfg, ch) * divPx;
        },
        true,
      );
    }
    if (cfg.math !== "off") {
      const mdiv = cfg.math === "mul" ? cfg.vdiv[0] * cfg.vdiv[1] : Math.max(cfg.vdiv[0], cfg.vdiv[1]);
      trace(c, buf, i0, i1, sweep, rect, u, MATH_COLOR, (idx) => (mathFn(idx) / mdiv) * divPx, false);
    }
    markers(c, rect, u, cfg, sweep, dcs);
  }

  // hover cursor
  if (o.hover !== null && !cfg.xy) {
    const hx = x + o.hover * w;
    const t = sweep.t0 + o.hover * sweep.span;
    const k = buf.lowerBound(t);
    const at = (ch: number): number | null => {
      if (k <= 0 || k >= buf.count) return null;
      const ta = buf.timeAt(k - 1);
      const tb = buf.timeAt(k);
      const va = buf.ch[ch]![buf.idx(k - 1)]!;
      const vb = buf.ch[ch]![buf.idx(k)]!;
      return tb === ta ? vb : va + ((vb - va) * (t - ta)) / (tb - ta);
    };
    result.hover = { t: sweep.triggered ? t - sweep.tTrig : t - sweep.t0, v: [at(0), at(1)] };
    c.strokeStyle = "rgba(255,255,255,0.55)";
    c.lineWidth = u;
    c.setLineDash([4 * u, 3 * u]);
    c.beginPath();
    c.moveTo(hx, y);
    c.lineTo(hx, y + h);
    c.stroke();
    c.setLineDash([]);
  }

  // legend strip
  if (o.labels) {
    const fs = 10.5 * u;
    c.font = `${fs}px ui-monospace, monospace`;
    c.textBaseline = "alphabetic";
    c.textAlign = "left";
    c.fillStyle = "rgba(4,16,10,0.72)";
    c.fillRect(x, y + h - fs * 1.7, w, fs * 1.7);
    let px = x + 8 * u;
    const by = y + h - fs * 0.5;
    const put = (text: string, color: string): void => {
      c.fillStyle = color;
      c.fillText(text, px, by);
      px += c.measureText(text).width + 14 * u;
    };
    if (cfg.xy) {
      put(`X ${formatEng(cfg.vdiv[0], "volt", 3)}/div`, CH_COLORS[0]);
      put(`Y ${formatEng(cfg.vdiv[1], "volt", 3)}/div`, CH_COLORS[1]);
    } else {
      if (cfg.on[0]) put(`CH1 ${formatEng(cfg.vdiv[0], "volt", 3)}/div ${cfg.cpl[0].toUpperCase()}`, CH_COLORS[0]);
      if (cfg.on[1]) put(`CH2 ${formatEng(cfg.vdiv[1], "volt", 3)}/div ${cfg.cpl[1].toUpperCase()}`, CH_COLORS[1]);
      if (cfg.math !== "off") put(`M ${cfg.math === "add" ? "1+2" : cfg.math === "sub" ? "1−2" : "1×2"}`, MATH_COLOR);
      put(`${formatEng(cfg.tdiv, "second", 3)}/div`, "#c9d4cf");
      put(
        `T ${cfg.trigSrc === 0 ? "1" : "2"}${cfg.trigRising ? "↑" : "↓"} ${formatEng(sweep.level, "volt", 3)} ${cfg.trigAuto ? "AUTO" : "NORM"}`,
        sweep.triggered ? "#ff9d2e" : "#8a8f94",
      );
    }
    if (o.frozen) {
      c.fillStyle = "#ff4d5e";
      c.textAlign = "right";
      c.fillText("■ STOP", x + w - 8 * u, by);
    } else if (!sweep.triggered && !cfg.xy) {
      c.fillStyle = "#8a8f94";
      c.textAlign = "right";
      c.fillText("FREE RUN", x + w - 8 * u, by);
    }
  }
  c.restore();
  c.strokeStyle = o.accent ?? "#39ff88";
  c.lineWidth = u;
  c.strokeRect(x, y, w, h);
  return result;
}
