import { CATALOG } from "@/models/catalog";
import {
  componentBBox,
  distToPolyline,
  localToWorld,
  pinWorld,
  pointAlong,
  polylineLength,
  wirePolyline,
} from "@/models/geometry";
import { pinKey, GRID_PX } from "@/models/types";
import type { PinRef, PlacedComponent, SimSnapshot, Vec2, Wire } from "@/models/types";
import { formatEng } from "@/models/units";
import { burnTimes } from "@/engine/runtime";
import { drawComponent } from "./symbols";
import type { ViewStyle } from "@/store/viewportStore";

export interface Theme {
  bg: string;
  grid: string;
  gridMajor: string;
  stroke: string;
  dim: string;
  accent: string;
  select: string;
  vcc: string;
  gnd: string;
  signal: string;
  high: string;
  low: string;
  floating: string;
  labelBg: string;
  dots: string;
}

export const DARK_THEME: Theme = {
  bg: "#0a0b0d",
  grid: "rgba(120,135,155,0.20)",
  gridMajor: "rgba(120,135,155,0.38)",
  stroke: "#d7dde5",
  dim: "#8a94a3",
  accent: "#2fd8ff",
  select: "#2fd8ff",
  vcc: "#ff4d5e",
  gnd: "#7d8794",
  signal: "#ffd23f",
  high: "#ff4d5e",
  low: "#4d8dff",
  floating: "#7d8794",
  labelBg: "rgba(10,11,13,0.8)",
  dots: "#ffffff",
};

export const PRINT_THEME: Theme = {
  bg: "#ffffff",
  grid: "rgba(0,0,0,0.12)",
  gridMajor: "rgba(0,0,0,0.2)",
  stroke: "#111111",
  dim: "#555555",
  accent: "#0a6e8a",
  select: "#0a6e8a",
  vcc: "#c0182a",
  gnd: "#111111",
  signal: "#9a7400",
  high: "#c0182a",
  low: "#1f4fc0",
  floating: "#777777",
  labelBg: "rgba(255,255,255,0.85)",
  dots: "#111111",
};

export type WireClass = "vcc" | "gnd" | "signal";

export interface SceneArgs {
  components: readonly PlacedComponent[];
  wires: readonly Wire[];
  view: ViewStyle;
  theme: Theme;
  snapshot: SimSnapshot | null;
  selectedComponents: ReadonlySet<string>;
  selectedWires: ReadonlySet<string>;
  showCurrent: boolean;
  wireClass: ReadonlyMap<string, WireClass>;
  hoverPin: PinRef | null;
  now: number;
  /** Zoom is needed so that screen-space things (dots, text) keep constant pixel size. */
  zoom: number;
  animate: boolean;
}

const G = GRID_PX;

export function classifyWires(
  components: readonly PlacedComponent[],
  wires: readonly Wire[],
  pinNet: ReadonlyMap<string, string>,
  netPins: ReadonlyMap<string, string[]>,
): Map<string, WireClass> {
  const byId = new Map(components.map((c) => [c.id, c]));
  const classOfNet = new Map<string, WireClass>();
  for (const [net, pins] of netPins) {
    let gnd = false;
    let pwr = false;
    for (const key of pins) {
      const [cid, pid] = key.split(":") as [string, string];
      const comp = byId.get(cid);
      const def = comp && CATALOG.get(comp.kind);
      const pd = def?.pins.find((q) => q.id === pid);
      if (def?.sim === "ground" || pd?.kind === "ground") gnd = true;
      else if (pd?.kind === "power") pwr = true;
    }
    classOfNet.set(net, gnd ? "gnd" : pwr ? "vcc" : "signal");
  }
  const out = new Map<string, WireClass>();
  for (const w of wires) {
    const net = pinNet.get(pinKey(w.from));
    out.set(w.id, (net && classOfNet.get(net)) || "signal");
  }
  return out;
}

export function valueText(c: PlacedComponent): string {
  const p = c.params;
  const n = (k: string): number => (typeof p[k] === "number" ? (p[k] as number) : 0);
  switch (c.kind) {
    case "resistor":
    case "potentiometer":
    case "trimmer":
      return formatEng(n("resistance"), "ohm");
    case "cap_ceramic":
    case "cap_electrolytic":
    case "cap_tantalum":
      return formatEng(n("capacitance"), "farad");
    case "inductor":
      return formatEng(n("inductance"), "henry");
    case "vdc":
    case "battery_9v":
    case "battery_aa":
    case "battery_lipo":
      return formatEng(n("voltage"), "volt");
    case "vac":
      return `${formatEng(n("amplitude"), "volt")} ${formatEng(n("frequency"), "hertz")}`;
    case "sigen":
      return `${String(p.waveform)} ${formatEng(n("frequency"), "hertz")}`;
    case "zener":
      return formatEng(n("vz"), "volt");
    case "led":
      return String(p.color);
    case "ldr":
      return `${n("lux")} lx`;
    case "ntc":
    case "ptc":
      return `${n("temp")} °C`;
    case "buzzer":
    case "dc_motor":
      return formatEng(n("resistance"), "ohm");
    default:
      return "";
  }
}

export function pinPoint(c: PlacedComponent, pinId: string): Vec2 {
  const w = pinWorld(c, pinId);
  return { x: w.x * G, y: w.y * G };
}

export function drawScene(ctx: CanvasRenderingContext2D, a: SceneArgs): void {
  const byId = new Map(a.components.map((c) => [c.id, c]));
  const snap = a.snapshot;
  const t = a.theme;

  // ───── wires
  const connected = new Set<string>();
  for (const w of a.wires) {
    const pts = wirePolyline(w, byId);
    if (!pts) continue;
    connected.add(pinKey(w.from));
    connected.add(pinKey(w.to));
    const px = pts.map((p) => ({ x: p.x * G, y: p.y * G }));

    let color: string;
    if (w.color === "custom" && w.custom) color = w.custom;
    else if (w.color === "vcc") color = t.vcc;
    else if (w.color === "gnd") color = t.gnd;
    else if (w.color === "signal") color = t.signal;
    else {
      const cls = a.wireClass.get(w.id) ?? "signal";
      color = cls === "vcc" ? t.vcc : cls === "gnd" ? t.gnd : t.signal;
      const net = snap?.wireNet[w.id];
      const lvl = net ? snap?.logic[net] : undefined;
      if (lvl === "high") color = t.high;
      else if (lvl === "low") color = t.low;
      else if (lvl === "floating") color = t.floating;
    }

    const sel = a.selectedWires.has(w.id);
    ctx.save();
    ctx.lineJoin = "round";
    ctx.lineCap = "round";
    if (sel) {
      ctx.strokeStyle = t.select;
      ctx.globalAlpha = 0.35;
      ctx.lineWidth = 7;
      strokePoly(ctx, px);
      ctx.globalAlpha = 1;
    }
    ctx.strokeStyle = color;
    ctx.lineWidth = 2.2;
    strokePoly(ctx, px);
    ctx.restore();

    // current flow dots
    const i = snap?.wireCurrent[w.id] ?? 0;
    if (a.showCurrent && snap && Math.abs(i) > 1e-6) {
      const len = polylineLength(pts) * G;
      if (len > 1) {
        const spacing = 14;
        const speed = (14 + 16 * Math.max(0, Math.min(4, Math.log10(Math.abs(i)) + 6))) * Math.sign(i);
        const off = a.animate ? (((a.now / 1000) * speed) % spacing + spacing) % spacing : 0;
        ctx.save();
        ctx.fillStyle = t.dots;
        ctx.globalAlpha = 0.9;
        const r = 2.1 / Math.max(0.6, Math.min(1.5, a.zoom));
        for (let d = off; d < len; d += spacing) {
          const q = pointAlong(px, d);
          ctx.beginPath();
          ctx.arc(q.x, q.y, r, 0, Math.PI * 2);
          ctx.fill();
        }
        ctx.restore();
      }
    }
  }

  // ───── components
  for (const c of a.components) {
    const def = CATALOG.get(c.kind);
    if (!def) continue;
    const cs = snap?.components[c.id];
    const burned = !!cs?.burned;
    const sel = a.selectedComponents.has(c.id);
    const stress = cs?.stress ?? 0;

    ctx.save();
    ctx.translate(c.x * G, c.y * G);
    ctx.rotate((c.rotation * Math.PI) / 180);
    if (c.mirror) ctx.scale(-1, 1);
    ctx.scale(G, G);

    // hot glow underneath
    if (!burned && stress > 0.7) {
      const [x0, y0, x1, y1] = def.bounds;
      const pulse = 0.5 + 0.5 * Math.sin(a.now / 110);
      const k = Math.min(1, (stress - 0.7) / 0.5);
      ctx.save();
      ctx.globalAlpha = (0.15 + 0.35 * k) * (0.6 + 0.4 * pulse);
      ctx.fillStyle = "#ff7a1a";
      ctx.beginPath();
      ctx.roundRect(x0 - 0.3, y0 - 0.3, x1 - x0 + 0.6, y1 - y0 + 0.6, 0.4);
      ctx.fill();
      ctx.restore();
    }

    drawComponent(ctx, c, def, {
      view: a.view,
      stroke: burned ? "#4a3a33" : sel ? t.select : t.stroke,
      dim: t.dim,
      accent: t.accent,
      snap: cs,
      rotation: c.rotation,
      mirror: c.mirror,
      burned,
      now: a.now,
    });
    ctx.restore();

    if (burned) drawBurn(ctx, c, a.now);

    // selection box
    if (sel) {
      const b = componentBBox(c);
      ctx.save();
      ctx.strokeStyle = t.select;
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.strokeRect(b.x0 * G - 6, b.y0 * G - 6, (b.x1 - b.x0) * G + 12, (b.y1 - b.y0) * G + 12);
      ctx.restore();
    }

    // label + value
    const bb = componentBBox(c);
    const lx = ((bb.x0 + bb.x1) / 2) * G;
    const ly = bb.y1 * G + 12;
    const value = valueText(c);
    ctx.save();
    ctx.font = "600 10px ui-monospace, Menlo, Consolas, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const text = value ? `${c.label}  ${value}` : c.label;
    const w = ctx.measureText(text).width + 8;
    ctx.fillStyle = t.labelBg;
    ctx.fillRect(lx - w / 2, ly - 7, w, 14);
    ctx.fillStyle = burned ? "#ff4d5e" : t.dim;
    ctx.fillText(c.label, lx - (value ? (ctx.measureText(`  ${value}`).width) / 2 : 0), ly);
    if (value) {
      ctx.fillStyle = t.accent;
      ctx.textAlign = "left";
      ctx.fillText(`  ${value}`, lx - w / 2 + 4 + ctx.measureText(c.label).width, ly);
    }
    ctx.restore();
  }

  // ───── pins on top
  for (const c of a.components) {
    const def = CATALOG.get(c.kind);
    if (!def) continue;
    for (const p of def.pins) {
      const wp = localToWorld(c, p);
      const key = pinKey({ componentId: c.id, pinId: p.id });
      const isConn = connected.has(key);
      const hover = a.hoverPin && a.hoverPin.componentId === c.id && a.hoverPin.pinId === p.id;
      ctx.save();
      ctx.beginPath();
      ctx.arc(wp.x * G, wp.y * G, hover ? 5 : isConn ? 2.6 : 3.4, 0, Math.PI * 2);
      if (isConn) {
        ctx.fillStyle = t.stroke;
        ctx.fill();
      } else {
        ctx.strokeStyle = hover ? t.select : t.accent;
        ctx.lineWidth = 1.2;
        ctx.fillStyle = t.bg;
        ctx.fill();
        ctx.stroke();
      }
      if (hover) {
        ctx.strokeStyle = t.select;
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      ctx.restore();
    }
  }
}

function strokePoly(ctx: CanvasRenderingContext2D, pts: Vec2[]): void {
  ctx.beginPath();
  ctx.moveTo(pts[0]!.x, pts[0]!.y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]!.x, pts[i]!.y);
  ctx.stroke();
}

/** Flash, soot and rising smoke for a component that has been destroyed. */
function drawBurn(ctx: CanvasRenderingContext2D, c: PlacedComponent, now: number): void {
  const def = CATALOG.get(c.kind);
  if (!def) return;
  const b = componentBBox(c);
  const cx = ((b.x0 + b.x1) / 2) * G;
  const cy = ((b.y0 + b.y1) / 2) * G;
  const t0 = burnTimes.get(c.id) ?? now - 10_000;
  const age = (now - t0) / 1000;

  ctx.save();
  // soot
  const r = Math.max(14, Math.max(b.x1 - b.x0, b.y1 - b.y0) * G * 0.42);
  const soot = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
  soot.addColorStop(0, "rgba(0,0,0,0.75)");
  soot.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = soot;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.fill();

  // flash
  if (age < 0.5) {
    const k = 1 - age / 0.5;
    const flash = ctx.createRadialGradient(cx, cy, 0, cx, cy, r * 3.2);
    flash.addColorStop(0, `rgba(255,240,200,${0.95 * k})`);
    flash.addColorStop(0.35, `rgba(255,140,30,${0.7 * k})`);
    flash.addColorStop(1, "rgba(255,60,0,0)");
    ctx.globalCompositeOperation = "lighter";
    ctx.fillStyle = flash;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 3.2, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }

  // smoke puffs (a few seconds, then a faint wisp keeps going)
  const puffs = 7;
  for (let i = 0; i < puffs; i++) {
    const phase = ((now / 2600 + i / puffs) % 1 + 1) % 1;
    const seed = Math.sin(i * 91.7 + c.x * 12.9 + c.y * 78.2) * 43758.5453;
    const jitter = seed - Math.floor(seed) - 0.5;
    const fade = age < 6 ? 1 : Math.max(0.25, 1 - (age - 6) / 12);
    ctx.globalAlpha = (1 - phase) * 0.32 * fade;
    ctx.fillStyle = "#9aa1ab";
    ctx.beginPath();
    ctx.arc(cx + jitter * 16 + Math.sin(phase * 6 + i) * 5, cy - phase * 46, 4 + phase * 11, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  ctx.font = "700 11px ui-monospace, Menlo, Consolas, monospace";
  ctx.textAlign = "center";
  ctx.fillStyle = "#ff4d5e";
  ctx.fillText("✕ BURNT", cx, b.y0 * G - 10);
  ctx.restore();
}

export function wireHit(w: Wire, byId: ReadonlyMap<string, PlacedComponent>, p: Vec2, tol: number): boolean {
  const pts = wirePolyline(w, byId);
  return !!pts && distToPolyline(p, pts) <= tol;
}
