"use client";

import { useEffect, useRef } from "react";
import { buildNetlist } from "@/engine/netlist";
import { getLive, sim, burnTimes } from "@/engine/runtime";
import { CATALOG, getDef } from "@/models/catalog";
import {
  componentBBox,
  hitComponent,
  localToWorld,
  orthogonalRoute,
  pinOutward,
  snap as snapTo,
  worldToLocal,
} from "@/models/geometry";
import { GRID_PX, type PinRef, type PlacedComponent, type Rotation, type Vec2 } from "@/models/types";
import { formatEng } from "@/models/units";
import { exportJson } from "@/storage/exporters";
import { useCircuitStore } from "@/store/circuitStore";
import { useSimStore } from "@/store/simulationStore";
import { useSettingsStore } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { useViewportStore } from "@/store/viewportStore";
import { classifyWires, DARK_THEME, drawScene, wireHit, type WireClass } from "./renderScene";
import { drawComponent } from "./symbols";

const G = GRID_PX;
export const DND_MIME = "application/x-circuitlab-kind";

type Mode =
  | { kind: "idle" }
  | { kind: "pan"; lastX: number; lastY: number; button: number; moved: boolean }
  | { kind: "move"; ids: string[]; startX: number; startY: number; applied: Vec2; moved: boolean; clicked: string }
  | { kind: "box"; x0: number; y0: number; additive: boolean }
  | { kind: "press"; id: string };

interface Wiring {
  from: PinRef;
}

function isTyping(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  if (!el) return false;
  return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable;
}

export function CircuitCanvas(): React.JSX.Element {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const ctx = canvas.getContext("2d")!;

    let dirty = true;
    let raf = 0;
    let w = 0;
    let h = 0;
    let dpr = 1;

    const mouse = { sx: 0, sy: 0, inside: false };
    let mode: Mode = { kind: "idle" };
    let wiring: Wiring | null = null;
    let hoverPin: PinRef | null = null;
    let hoverComp: string | null = null;
    let spaceDown = false;
    let boxRect: { x0: number; y0: number; x1: number; y1: number } | null = null;

    // hover-dwell help card
    let helpTimer = 0;
    let helpFor: string | null = null;
    let clientPos = { x: 0, y: 0 };
    const clearHelp = (): void => {
      window.clearTimeout(helpTimer);
      helpFor = null;
      if (useUiStore.getState().helpHover) useUiStore.getState().setHelpHover(null);
    };
    const scheduleHelp = (compId: string | null): void => {
      if (compId === helpFor) return;
      clearHelp();
      if (!compId || !useSettingsStore.getState().hoverHelp) return;
      helpFor = compId;
      helpTimer = window.setTimeout(() => {
        const c = useCircuitStore.getState().components.find((x) => x.id === compId);
        const ui = useUiStore.getState();
        if (!c || helpFor !== compId || mode.kind !== "idle" || wiring || ui.placingKind) return;
        ui.setHelpHover({ kind: c.kind, x: clientPos.x, y: clientPos.y });
      }, 650);
    };

    let wireClass: Map<string, WireClass> = new Map();
    let classRevision = -1;

    const mark = (): void => {
      dirty = true;
    };

    const unsubs = [
      useCircuitStore.subscribe(mark),
      useViewportStore.subscribe(mark),
      useUiStore.subscribe(mark),
      useSimStore.subscribe(mark),
    ];

    // ───────── geometry helpers

    const toWorld = (sx: number, sy: number): Vec2 => {
      const v = useViewportStore.getState();
      return { x: (sx - v.panX) / v.zoom / G, y: (sy - v.panY) / v.zoom / G };
    };
    const snapPt = (p: Vec2): Vec2 => (useViewportStore.getState().snapToGrid ? { x: snapTo(p.x), y: snapTo(p.y) } : p);

    const pinAt = (p: Vec2): PinRef | null => {
      const v = useViewportStore.getState();
      const tol = 9 / (v.zoom * G);
      let best: { ref: PinRef; d: number } | null = null;
      for (const c of useCircuitStore.getState().components) {
        const def = CATALOG.get(c.kind);
        if (!def) continue;
        for (const pin of def.pins) {
          const wp = localToWorld(c, pin);
          const d = Math.hypot(wp.x - p.x, wp.y - p.y);
          if (d <= tol && (!best || d < best.d)) best = { ref: { componentId: c.id, pinId: pin.id }, d };
        }
      }
      return best?.ref ?? null;
    };

    const componentAt = (p: Vec2): PlacedComponent | null => {
      const comps = useCircuitStore.getState().components;
      for (let i = comps.length - 1; i >= 0; i--) if (hitComponent(comps[i]!, p)) return comps[i]!;
      return null;
    };

    const wireAt = (p: Vec2): string | null => {
      const { components, wires } = useCircuitStore.getState();
      const byId = new Map(components.map((c) => [c.id, c]));
      const tol = 6 / (useViewportStore.getState().zoom * G);
      for (let i = wires.length - 1; i >= 0; i--) if (wireHit(wires[i]!, byId, p, tol)) return wires[i]!.id;
      return null;
    };

    /** Origin that centres a part (in the given orientation) under the cursor. */
    const placementOrigin = (kind: string, world: Vec2, rotation: Rotation, mirror: boolean): Vec2 => {
      const probe: PlacedComponent = { id: "probe", kind, x: 0, y: 0, rotation, mirror, params: {}, label: "" };
      const b = componentBBox(probe);
      return snapPt({ x: world.x - Math.round((b.x0 + b.x1) / 2), y: world.y - Math.round((b.y0 + b.y1) / 2) });
    };

    const simActive = (): boolean => useSimStore.getState().running || sim.time > 0;

    // ───────── drawing

    const resize = (): void => {
      const r = wrap.getBoundingClientRect();
      dpr = window.devicePixelRatio || 1;
      w = Math.max(1, Math.floor(r.width));
      h = Math.max(1, Math.floor(r.height));
      canvas.width = Math.floor(w * dpr);
      canvas.height = Math.floor(h * dpr);
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
      mark();
    };
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);
    resize();

    const drawGrid = (): void => {
      const v = useViewportStore.getState();
      if (v.gridMode === "none") return;
      const step = G * v.zoom;
      const minor = step >= 8;
      const x0 = ((v.panX % step) + step) % step;
      const y0 = ((v.panY % step) + step) % step;
      const originCol = Math.round(-v.panX / step);
      const originRow = Math.round(-v.panY / step);
      ctx.save();
      if (v.gridMode === "dots") {
        for (let x = x0, i = 0; x < w; x += step, i++) {
          for (let y = y0, j = 0; y < h; y += step, j++) {
            const major = (Math.round((x - v.panX) / step) % 5 === 0) && (Math.round((y - v.panY) / step) % 5 === 0);
            if (!minor && !major) continue;
            ctx.fillStyle = major ? DARK_THEME.gridMajor : DARK_THEME.grid;
            const s = major ? 1.8 : 1.1;
            ctx.fillRect(x - s / 2, y - s / 2, s, s);
          }
        }
      } else {
        ctx.lineWidth = 1;
        for (let x = x0; x < w; x += step) {
          const major = Math.round((x - v.panX) / step) % 5 === 0;
          if (!minor && !major) continue;
          ctx.strokeStyle = major ? DARK_THEME.gridMajor : DARK_THEME.grid;
          ctx.globalAlpha = major ? 0.8 : 0.5;
          ctx.beginPath();
          ctx.moveTo(Math.round(x) + 0.5, 0);
          ctx.lineTo(Math.round(x) + 0.5, h);
          ctx.stroke();
        }
        for (let y = y0; y < h; y += step) {
          const major = Math.round((y - v.panY) / step) % 5 === 0;
          if (!minor && !major) continue;
          ctx.strokeStyle = major ? DARK_THEME.gridMajor : DARK_THEME.grid;
          ctx.globalAlpha = major ? 0.8 : 0.5;
          ctx.beginPath();
          ctx.moveTo(0, Math.round(y) + 0.5);
          ctx.lineTo(w, Math.round(y) + 0.5);
          ctx.stroke();
        }
      }
      void originCol;
      void originRow;
      // origin crosshair
      ctx.globalAlpha = 0.5;
      ctx.strokeStyle = DARK_THEME.accent;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(v.panX - 8, v.panY);
      ctx.lineTo(v.panX + 8, v.panY);
      ctx.moveTo(v.panX, v.panY - 8);
      ctx.lineTo(v.panX, v.panY + 8);
      ctx.stroke();
      ctx.restore();
    };

    const ensureWireClass = (): void => {
      const cs = useCircuitStore.getState();
      if (classRevision === cs.revision) return;
      classRevision = cs.revision;
      const nl = buildNetlist(cs.components, cs.wires);
      const netPins = new Map<string, string[]>();
      for (const [id, n] of nl.nets) netPins.set(id, n.pins);
      wireClass = classifyWires(cs.components, cs.wires, nl.pinNet, netPins);
    };

    const drawOverlays = (now: number): void => {
      const v = useViewportStore.getState();
      const ui = useUiStore.getState();
      const cs = useCircuitStore.getState();
      const mw = toWorld(mouse.sx, mouse.sy);

      // placement ghost
      if (ui.placingKind && mouse.inside) {
        const def = getDef(ui.placingKind);
        const p = placementOrigin(def.kind, mw, ui.placeRotation, ui.placeMirror);
        const ghost: PlacedComponent = {
          id: "ghost",
          kind: def.kind,
          x: p.x,
          y: p.y,
          rotation: ui.placeRotation,
          mirror: ui.placeMirror,
          params: { ...def.defaults },
          label: def.prefix,
        };
        ctx.save();
        ctx.globalAlpha = 0.6;
        ctx.translate(ghost.x * G, ghost.y * G);
        ctx.rotate((ghost.rotation * Math.PI) / 180);
        if (ghost.mirror) ctx.scale(-1, 1);
        ctx.scale(G, G);
        drawComponent(ctx, ghost, def, {
          view: v.viewStyle,
          stroke: DARK_THEME.select,
          dim: DARK_THEME.dim,
          accent: DARK_THEME.accent,
          rotation: ui.placeRotation,
          mirror: ui.placeMirror,
          burned: false,
          now,
        });
        ctx.restore();

        // orientation read-out next to the ghost
        const bb = componentBBox(ghost);
        ctx.save();
        ctx.font = `${Math.max(9, 11 / v.zoom)}px ui-monospace, Menlo, Consolas, monospace`;
        ctx.fillStyle = DARK_THEME.select;
        ctx.textBaseline = "top";
        ctx.fillText(`${ui.placeRotation}°${ui.placeMirror ? " ⇋" : ""}  · R rotate`, bb.x0 * G, (bb.y1 + 0.4) * G);
        ctx.restore();
      }

      // wire in progress
      if (wiring) {
        const from = cs.components.find((c) => c.id === wiring!.from.componentId);
        if (from) {
          const a = localToWorld(from, getDef(from.kind).pins.find((p) => p.id === wiring!.from.pinId)!);
          const da = pinOutward(from, wiring.from.pinId);
          let b = snapPt(mw);
          let db: Vec2 = { x: 0, y: 0 };
          if (hoverPin) {
            const hc = cs.components.find((c) => c.id === hoverPin!.componentId);
            if (hc) {
              b = localToWorld(hc, getDef(hc.kind).pins.find((p) => p.id === hoverPin!.pinId)!);
              db = pinOutward(hc, hoverPin.pinId);
            }
          }
          const route = orthogonalRoute(a, da, b, db);
          ctx.save();
          ctx.strokeStyle = DARK_THEME.select;
          ctx.lineWidth = 2;
          ctx.setLineDash([6, 4]);
          ctx.lineDashOffset = -now / 40;
          ctx.beginPath();
          route.forEach((p, i) => (i === 0 ? ctx.moveTo(p.x * G, p.y * G) : ctx.lineTo(p.x * G, p.y * G)));
          ctx.stroke();
          ctx.restore();
        }
      }

      if (boxRect) {
        ctx.save();
        ctx.fillStyle = "rgba(47,216,255,0.08)";
        ctx.strokeStyle = DARK_THEME.select;
        ctx.lineWidth = 1 / v.zoom;
        ctx.setLineDash([4 / v.zoom, 3 / v.zoom]);
        const x = Math.min(boxRect.x0, boxRect.x1) * G;
        const y = Math.min(boxRect.y0, boxRect.y1) * G;
        const bw = Math.abs(boxRect.x1 - boxRect.x0) * G;
        const bh = Math.abs(boxRect.y1 - boxRect.y0) * G;
        ctx.fillRect(x, y, bw, bh);
        ctx.strokeRect(x, y, bw, bh);
        ctx.restore();
      }
    };

    const wrapText = (text: string, width: number): string[] => {
      const out: string[] = [];
      let line = "";
      for (const word of text.split(/\s+/)) {
        if (line && line.length + word.length + 1 > width) {
          out.push(line);
          line = word;
        } else line = line ? `${line} ${word}` : word;
      }
      if (line) out.push(line);
      return out;
    };

    const drawTooltip = (): void => {
      const v = useViewportStore.getState();
      const snap = getLive();
      if (!snap || !mouse.inside || mode.kind !== "idle") return;
      const lines: string[] = [];
      if (hoverPin) {
        const net = snap.pinNet[`${hoverPin.componentId}:${hoverPin.pinId}`];
        if (net && v.showVoltages) lines.push(`${formatEng(snap.netVoltage[net] ?? 0, "volt", 4)}`);
      } else if (hoverComp) {
        const cs = snap.components[hoverComp];
        if (cs?.burned && cs.failure) {
          lines.push("✕ FAILED", ...wrapText(cs.failure, 52));
        } else if (cs && v.showVoltages) {
          lines.push(`V ${formatEng(cs.voltage, "volt", 3)}   I ${formatEng(cs.current, "amp", 3)}`);
          lines.push(`P ${formatEng(Math.abs(cs.power), "watt", 3)}   load ${(cs.stress * 100).toFixed(0)}%`);
        }
      }
      if (lines.length === 0) return;
      ctx.save();
      ctx.font = "11px ui-monospace, Menlo, Consolas, monospace";
      const tw = Math.max(...lines.map((l) => ctx.measureText(l).width)) + 14;
      const th = lines.length * 15 + 8;
      const x = Math.min(w - tw - 6, mouse.sx + 14);
      const y = Math.min(h - th - 6, mouse.sy + 14);
      ctx.fillStyle = "rgba(16,18,22,0.94)";
      ctx.strokeStyle = lines[0] === "✕ FAILED" ? "#ff4d5e" : "#2fd8ff";
      ctx.lineWidth = 1;
      ctx.fillRect(x, y, tw, th);
      ctx.strokeRect(x + 0.5, y + 0.5, tw, th);
      ctx.textBaseline = "middle";
      lines.forEach((l, i) => {
        ctx.fillStyle = l === "✕ FAILED" ? "#ff4d5e" : "#d7dde5";
        ctx.fillText(l, x + 7, y + 12 + i * 15);
      });
      ctx.restore();
    };

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      const running = useSimStore.getState().running;
      const animating = running || burnTimes.size > 0 || wiring !== null;
      if (!dirty && !animating) return;
      dirty = false;

      const v = useViewportStore.getState();
      const cs = useCircuitStore.getState();
      ensureWireClass();

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = DARK_THEME.bg;
      ctx.fillRect(0, 0, canvas.width, canvas.height);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawGrid();

      ctx.setTransform(dpr * v.zoom, 0, 0, dpr * v.zoom, dpr * v.panX, dpr * v.panY);
      drawScene(ctx, {
        components: cs.components,
        wires: cs.wires,
        view: v.viewStyle,
        theme: DARK_THEME,
        snapshot: getLive(),
        selectedComponents: new Set(cs.selection.components),
        selectedWires: new Set(cs.selection.wires),
        showCurrent: v.showCurrent,
        wireClass,
        hoverPin,
        now,
        zoom: v.zoom,
        animate: true,
      });
      drawOverlays(now);

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      drawTooltip();
    };
    raf = requestAnimationFrame(frame);

    // ───────── pointer handling

    const local = (e: MouseEvent): { sx: number; sy: number } => {
      const r = canvas.getBoundingClientRect();
      return { sx: e.clientX - r.left, sy: e.clientY - r.top };
    };

    const finishWire = (to: PinRef): void => {
      if (!wiring) return;
      const ui = useUiStore.getState();
      const id = useCircuitStore
        .getState()
        .addWire(wiring.from, to, ui.wireColor, ui.wireRouting);
      if (id && ui.wireColor === "custom") useCircuitStore.getState().setWireColor(id, "custom", ui.wireCustomColor);
      wiring = null;
      mark();
    };

    const onPointerDown = (e: PointerEvent): void => {
      canvas.setPointerCapture(e.pointerId);
      clearHelp();
      const { sx, sy } = local(e);
      mouse.sx = sx;
      mouse.sy = sy;
      const world = toWorld(sx, sy);
      const ui = useUiStore.getState();
      const cs = useCircuitStore.getState();

      if (e.button === 1 || e.button === 2 || spaceDown || ui.tool === "pan") {
        mode = { kind: "pan", lastX: e.clientX, lastY: e.clientY, button: e.button, moved: false };
        return;
      }
      if (e.button !== 0) return;

      // placing
      if (ui.placingKind) {
        const p = placementOrigin(ui.placingKind, world, ui.placeRotation, ui.placeMirror);
        cs.addComponent(ui.placingKind, p.x, p.y, undefined, { rotation: ui.placeRotation, mirror: ui.placeMirror });
        return;
      }

      const pin = pinAt(world);
      if (pin) {
        if (wiring) {
          finishWire(pin);
        } else {
          wiring = { from: pin };
        }
        mark();
        return;
      }
      if (wiring) {
        wiring = null; // click on empty space cancels
        mark();
        return;
      }
      if (ui.tool === "wire") {
        // wire tool needs a pin; empty clicks do nothing
        return;
      }

      const comp = componentAt(world);
      if (comp) {
        // runtime interaction with switches while the simulation is live
        if (simActive()) {
          if (comp.kind === "pushbutton") {
            cs.setRuntimeParam(comp.id, "closed", true);
            mode = { kind: "press", id: comp.id };
            cs.select({ components: [comp.id] });
            return;
          }
        }
        const already = cs.selection.components.includes(comp.id);
        if (e.shiftKey) cs.select({ components: [comp.id] }, true);
        else if (!already) cs.select({ components: [comp.id] });
        const ids = useCircuitStore.getState().selection.components;
        if (ids.length > 0 && ids.includes(comp.id)) {
          cs.checkpoint();
          mode = { kind: "move", ids, startX: world.x, startY: world.y, applied: { x: 0, y: 0 }, moved: false, clicked: comp.id };
        }
        mark();
        return;
      }

      const wid = wireAt(world);
      if (wid) {
        cs.select({ wires: [wid] }, e.shiftKey);
        mark();
        return;
      }

      // empty: box select
      if (!e.shiftKey) cs.clearSelection();
      mode = { kind: "box", x0: world.x, y0: world.y, additive: e.shiftKey };
      boxRect = { x0: world.x, y0: world.y, x1: world.x, y1: world.y };
      mark();
    };

    const onPointerMove = (e: PointerEvent): void => {
      const { sx, sy } = local(e);
      mouse.sx = sx;
      mouse.sy = sy;
      mouse.inside = true;
      clientPos = { x: e.clientX, y: e.clientY };
      const world = toWorld(sx, sy);

      if (mode.kind === "pan") {
        const dx = e.clientX - mode.lastX;
        const dy = e.clientY - mode.lastY;
        if (Math.abs(dx) + Math.abs(dy) > 0) mode.moved = true;
        mode.lastX = e.clientX;
        mode.lastY = e.clientY;
        useViewportStore.getState().panBy(dx, dy);
        return;
      }
      if (mode.kind === "move") {
        const dx = world.x - mode.startX;
        const dy = world.y - mode.startY;
        const snapOn = useViewportStore.getState().snapToGrid;
        const nx = snapOn ? Math.round(dx) : dx;
        const ny = snapOn ? Math.round(dy) : dy;
        if (nx !== mode.applied.x || ny !== mode.applied.y) {
          useCircuitStore.getState().moveComponents(mode.ids, nx - mode.applied.x, ny - mode.applied.y);
          mode.applied = { x: nx, y: ny };
          mode.moved = true;
        }
        return;
      }
      if (mode.kind === "box" && boxRect) {
        boxRect.x1 = world.x;
        boxRect.y1 = world.y;
        mark();
        return;
      }

      const prevPin = hoverPin;
      const prevComp = hoverComp;
      hoverPin = pinAt(world);
      hoverComp = hoverPin ? null : (componentAt(world)?.id ?? null);
      if (mode.kind === "idle") scheduleHelp(hoverComp);
      if (hoverPin !== prevPin || hoverComp !== prevComp || wiring || useUiStore.getState().placingKind || getLive()) mark();
      canvas.style.cursor = hoverPin
        ? "crosshair"
        : spaceDown || useUiStore.getState().tool === "pan"
          ? "grab"
          : hoverComp
            ? "move"
            : "default";
    };

    const onPointerUp = (e: PointerEvent): void => {
      const m = mode;
      mode = { kind: "idle" };
      canvas.releasePointerCapture(e.pointerId);
      const cs = useCircuitStore.getState();
      const { sx, sy } = local(e);
      const world = toWorld(sx, sy);

      if (m.kind === "pan" && m.button === 2 && !m.moved) {
        // right-click: select + open inspector
        const comp = componentAt(world);
        const wid = comp ? null : wireAt(world);
        if (comp) cs.select({ components: [comp.id] });
        else if (wid) cs.select({ wires: [wid] });
        else {
          useUiStore.getState().setPlacing(null);
          wiring = null;
        }
        if (comp || wid) useUiStore.getState().setInspectorOpen(true);
        mark();
        return;
      }
      if (m.kind === "press") {
        cs.setRuntimeParam(m.id, "closed", false);
        return;
      }
      if (m.kind === "move" && !m.moved && simActive()) {
        const comp = cs.components.find((c) => c.id === m.clicked);
        if (comp?.kind === "toggle_switch") {
          cs.setRuntimeParam(comp.id, "closed", comp.params.closed !== true);
        } else if (comp?.kind === "dip_switch") {
          const l = worldToLocal(comp, world);
          const idx = Math.round(l.y);
          if (idx >= 1 && idx <= 4) cs.setRuntimeParam(comp.id, `s${idx}`, comp.params[`s${idx}`] !== true);
        }
      }
      if (m.kind === "move" && !m.moved) {
        // nothing moved: drop the checkpoint we eagerly pushed
        const st = useCircuitStore.getState();
        useCircuitStore.setState({ past: st.past.slice(0, -1) });
      }
      if (m.kind === "box" && boxRect) {
        const x0 = Math.min(boxRect.x0, boxRect.x1);
        const x1 = Math.max(boxRect.x0, boxRect.x1);
        const y0 = Math.min(boxRect.y0, boxRect.y1);
        const y1 = Math.max(boxRect.y0, boxRect.y1);
        if (x1 - x0 > 0.2 || y1 - y0 > 0.2) {
          const ids = cs.components
            .filter((c) => {
              const b = componentBBox(c);
              return b.x1 >= x0 && b.x0 <= x1 && b.y1 >= y0 && b.y0 <= y1;
            })
            .map((c) => c.id);
          cs.select({ components: ids }, m.additive);
        }
        boxRect = null;
        mark();
      }
    };

    const onPointerLeave = (): void => {
      clearHelp();
      mouse.inside = false;
      hoverPin = null;
      hoverComp = null;
      mark();
    };

    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      const { sx, sy } = local(e);
      const vp = useViewportStore.getState();
      if (e.shiftKey && !e.ctrlKey) {
        vp.panBy(-e.deltaY, 0);
        return;
      }
      if (!e.ctrlKey && Math.abs(e.deltaX) > Math.abs(e.deltaY) * 2) {
        vp.panBy(-e.deltaX, 0);
        return;
      }
      vp.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), sx, sy);
    };

    const onDoubleClick = (e: MouseEvent): void => {
      const { sx, sy } = local(e);
      const comp = componentAt(toWorld(sx, sy));
      if (comp) {
        useCircuitStore.getState().select({ components: [comp.id] });
        useUiStore.getState().setInspectorOpen(true);
      }
    };

    const onContextMenu = (e: Event): void => e.preventDefault();

    const onDragOver = (e: DragEvent): void => {
      if (e.dataTransfer?.types.includes(DND_MIME)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }
    };
    const onDrop = (e: DragEvent): void => {
      const kind = e.dataTransfer?.getData(DND_MIME);
      if (!kind || !CATALOG.has(kind)) return;
      e.preventDefault();
      const r = canvas.getBoundingClientRect();
      const world = toWorld(e.clientX - r.left, e.clientY - r.top);
      const p = placementOrigin(kind, world, 0, false);
      useCircuitStore.getState().addComponent(kind, p.x, p.y);
      canvas.focus();
    };

    // ───────── keyboard

    const onKeyDown = (e: KeyboardEvent): void => {
      if (isTyping(e.target)) return;
      const cs = useCircuitStore.getState();
      const ui = useUiStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const k = e.key.toLowerCase();

      if (e.code === "Space") {
        spaceDown = true;
        canvas.style.cursor = "grab";
        e.preventDefault();
        return;
      }
      if (mod && k === "z") {
        e.preventDefault();
        if (e.shiftKey) cs.redo();
        else cs.undo();
      } else if (mod && k === "y") {
        e.preventDefault();
        cs.redo();
      } else if (mod && k === "a") {
        e.preventDefault();
        cs.selectAll();
      } else if (mod && k === "d") {
        e.preventDefault();
        cs.duplicateSelection();
      } else if (mod && k === "c") {
        e.preventDefault();
        cs.copySelection();
      } else if (mod && k === "x") {
        e.preventDefault();
        cs.cutSelection();
      } else if (mod && k === "v") {
        e.preventDefault();
        cs.paste();
      } else if (mod && k === "s") {
        e.preventDefault();
        exportJson(cs.toData());
      } else if (!mod && k.startsWith("arrow")) {
        e.preventDefault();
        const step = e.shiftKey ? 5 : 1;
        cs.nudgeSelection(k === "arrowleft" ? -step : k === "arrowright" ? step : 0, k === "arrowup" ? -step : k === "arrowdown" ? step : 0);
      } else if (!mod && (k === "delete" || k === "backspace")) {
        e.preventDefault();
        cs.deleteSelection();
      } else if (!mod && k === "r") {
        // while a part is armed for placement, R turns the ghost (not the selection)
        if (ui.placingKind) ui.rotatePlacing(e.shiftKey);
        else cs.rotateSelection();
      } else if (!mod && k === "f") {
        if (ui.placingKind) ui.flipPlacing();
        else cs.mirrorSelection();
      } else if (!mod && k === "w") {
        ui.setTool("wire");
      } else if (!mod && k === "v") {
        ui.setTool("select");
      } else if (!mod && k === "g") {
        const vp = useViewportStore.getState();
        vp.setGridMode(vp.gridMode === "dots" ? "lines" : vp.gridMode === "lines" ? "none" : "dots");
      } else if (k === "escape") {
        wiring = null;
        ui.setPlacing(null);
        ui.setTool("select");
        cs.clearSelection();
      } else {
        return;
      }
      mark();
    };
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code === "Space") {
        spaceDown = false;
        canvas.style.cursor = "default";
      }
    };

    canvas.addEventListener("pointerdown", onPointerDown);
    canvas.addEventListener("pointermove", onPointerMove);
    canvas.addEventListener("pointerup", onPointerUp);
    canvas.addEventListener("pointerleave", onPointerLeave);
    canvas.addEventListener("wheel", onWheel, { passive: false });
    canvas.addEventListener("dblclick", onDoubleClick);
    canvas.addEventListener("contextmenu", onContextMenu);
    canvas.addEventListener("dragover", onDragOver);
    canvas.addEventListener("drop", onDrop);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);

    return () => {
      clearHelp();
      cancelAnimationFrame(raf);
      ro.disconnect();
      unsubs.forEach((u) => u());
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointermove", onPointerMove);
      canvas.removeEventListener("pointerup", onPointerUp);
      canvas.removeEventListener("pointerleave", onPointerLeave);
      canvas.removeEventListener("wheel", onWheel);
      canvas.removeEventListener("dblclick", onDoubleClick);
      canvas.removeEventListener("contextmenu", onContextMenu);
      canvas.removeEventListener("dragover", onDragOver);
      canvas.removeEventListener("drop", onDrop);
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
    };
  }, []);

  return (
    <div ref={wrapRef} className="absolute inset-0 overflow-hidden">
      <canvas ref={canvasRef} tabIndex={0} className="block touch-none outline-none" />
    </div>
  );
}
