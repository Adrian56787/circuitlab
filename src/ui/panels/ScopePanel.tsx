"use client";

import { Camera, Eraser, Square, Wand2 } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { probes } from "@/engine/probes";
import { autoSet, cfgFromParams, ladder, type Measure, type Sweep } from "@/engine/scopeMath";
import { formatEng, parseEng } from "@/models/units";
import type { PlacedComponent } from "@/models/types";
import { cn } from "@/lib/utils";
import { useCircuitStore } from "@/store/circuitStore";
import { useSimStore } from "@/store/simulationStore";
import { CH_COLORS, MATH_COLOR, drawScope, type HoverInfo, type ScopeDrawResult } from "../scope/renderScope";
import { Input } from "../primitives/input";

const LOGIC_COLORS = ["#ff4d5e", "#ffb020", "#ffe62a", "#39ff88", "#2fd8ff", "#4d8dff", "#b38bff", "#ff7ad9"];

// ───────────────────────── small controls ─────────────────────────

function Seg<T extends string>({
  value,
  options,
  onChange,
  color,
}: {
  value: T;
  options: [T, string][];
  onChange: (v: T) => void;
  color?: string;
}): React.JSX.Element {
  return (
    <div className="inline-flex border border-bg-line">
      {options.map(([v, label]) => (
        <button
          key={v}
          type="button"
          onClick={() => onChange(v)}
          className={cn(
            "h-6 px-2 font-mono text-[10px] uppercase",
            value === v ? "bg-bg-raised text-ink" : "text-ink-faint hover:text-ink-dim",
          )}
          style={value === v && color ? { color, boxShadow: `inset 0 -2px 0 ${color}` } : undefined}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** Select over a 1-2-5 ladder that also shows the current value when it is off-ladder. */
function LadderSelect({
  value,
  values,
  family,
  suffix,
  onChange,
  color,
}: {
  value: number;
  values: number[];
  family: "volt" | "second";
  suffix?: string;
  onChange: (v: number) => void;
  color?: string;
}): React.JSX.Element {
  const list = useMemo(() => {
    const has = values.some((v) => Math.abs(v - value) <= value * 1e-6);
    return has ? values : [...values, value].sort((a, b) => a - b);
  }, [values, value]);
  const cur = list.find((v) => Math.abs(v - value) <= value * 1e-6) ?? value;
  return (
    <select
      value={String(cur)}
      onChange={(e) => onChange(Number(e.target.value))}
      className="h-6 border border-bg-line bg-bg px-1 font-mono text-[11px]"
      style={{ color: color ?? "#e6edf3" }}
    >
      {list.map((v) => (
        <option key={v} value={String(v)}>
          {formatEng(v, family, 3)}
          {suffix ?? ""}
        </option>
      ))}
    </select>
  );
}

function LevelField({ value, onCommit }: { value: number; onCommit: (v: number) => void }): React.JSX.Element {
  const [text, setText] = useState(formatEng(value, "volt", 3));
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setText(formatEng(value, "volt", 3));
  }
  const commit = (): void => {
    const v = parseEng(text);
    if (Number.isFinite(v)) onCommit(v);
    else setText(formatEng(value, "volt", 3));
  };
  return (
    <Input
      className="h-6 w-[88px] text-[11px]"
      value={text}
      onChange={(e) => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
    />
  );
}

const fmtMeasure = (m: Measure | null): string =>
  m
    ? `Vpp ${formatEng(m.vpp, "volt", 3)} · avg ${formatEng(m.mean, "volt", 3)} · rms ${formatEng(m.rms, "volt", 3)}` +
      (m.freq ? ` · f ${formatEng(m.freq, "hertz", 3)} · T ${formatEng(1 / m.freq, "second", 3)}` : "")
    : "—";

// ───────────────────────── oscilloscope ─────────────────────────

function ScopeView({ comp }: { comp: PlacedComponent }): React.JSX.Element {
  const update = useCircuitStore((s) => s.updateParams);
  const running = useSimStore((s) => s.running);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const cfg = useMemo(() => cfgFromParams(comp.params), [comp.params]);
  const [frozen, setFrozen] = useState<Sweep | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [readout, setReadout] = useState<{ m: ScopeDrawResult["measures"]; h: HoverInfo | null; sweep: Sweep | null }>({
    m: [null, null, null],
    h: null,
    sweep: null,
  });
  const live = useRef<ScopeDrawResult | null>(null);
  const state = useRef({ cfg, frozen, hover, id: comp.id });
  state.current = { cfg, frozen, hover, id: comp.id };

  // draw loop: only repaints when something changed
  useEffect(() => {
    let raf = 0;
    let lastKey = "";
    const frame = (): void => {
      raf = requestAnimationFrame(frame);
      const canvas = canvasRef.current;
      if (!canvas) return;
      const { cfg: c, frozen: f, hover: hv, id } = state.current;
      const buf = probes().get(id);
      const rect = canvas.getBoundingClientRect();
      const key = `${buf?.lastT}|${buf?.count}|${JSON.stringify(c)}|${hv}|${f?.t0}|${rect.width}|${rect.height}`;
      if (key === lastKey) return;
      lastKey = key;
      const dpr = window.devicePixelRatio || 1;
      const w = Math.max(1, Math.round(rect.width * dpr));
      const h = Math.max(1, Math.round(rect.height * dpr));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
      }
      const ctx = canvas.getContext("2d")!;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      live.current = drawScope(ctx, 0, 0, rect.width, rect.height, c, buf, { unit: 1, labels: true, hover: hv, frozen: f });
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  // publish measurements to React ~6×/s
  useEffect(() => {
    const t = setInterval(() => {
      const r = live.current;
      if (r) setReadout({ m: r.measures, h: r.hover, sweep: r.sweep });
    }, 160);
    return () => clearInterval(t);
  }, []);

  const set = (patch: Record<string, number | string | boolean>): void => update(comp.id, patch);
  const vladder = useMemo(() => ladder(1e-3, 500), []);
  const tladder = useMemo(() => ladder(1e-7, 5), []);
  const p = comp.params;

  const stop = (): void => {
    if (frozen) setFrozen(null);
    else if (live.current?.sweep) setFrozen(live.current.sweep);
  };
  const auto = (): void => {
    const buf = probes().get(comp.id);
    if (!buf) return;
    setFrozen(null);
    const patch = autoSet(buf, cfg);
    if (Object.keys(patch).length) {
      update(comp.id, patch);
      buf.memo = null;
    }
  };
  const channel = (ch: 0 | 1): React.JSX.Element => {
    const k = ch + 1;
    const col = CH_COLORS[ch];
    return (
      <div className="flex flex-wrap items-center gap-2 border-t border-bg-line pt-1.5">
        <label className="flex w-12 items-center gap-1" style={{ color: col }}>
          <input type="checkbox" checked={cfg.on[ch]} onChange={(e) => set({ [`on${k}`]: e.target.checked })} />
          CH{k}
        </label>
        <LadderSelect value={cfg.vdiv[ch]} values={vladder} family="volt" suffix="/div" color={col} onChange={(v) => set({ [`vdiv${k}`]: v })} />
        <Seg
          value={cfg.cpl[ch]}
          options={[["dc", "DC"], ["ac", "AC"], ["gnd", "GND"]]}
          color={col}
          onChange={(v) => set({ [`cpl${k}`]: v })}
        />
        <label className="flex items-center gap-1 text-ink-faint">
          pos
          <input
            type="range"
            min={-4}
            max={4}
            step={0.1}
            value={cfg.pos[ch]}
            onChange={(e) => set({ [`pos${k}`]: Number(e.target.value) })}
            onDoubleClick={() => set({ [`pos${k}`]: 0 })}
            className="w-20"
            title="Double-click to centre"
          />
        </label>
      </div>
    );
  };

  const h = readout.h;
  return (
    <div className="flex h-full min-w-0 flex-1 gap-3">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="relative min-h-0 flex-1">
          <canvas
            ref={canvasRef}
            className="absolute inset-0 h-full w-full cursor-crosshair border border-bg-line"
            onPointerMove={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              setHover(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)));
            }}
            onPointerLeave={() => setHover(null)}
          />
        </div>
        <div className="mt-1 space-y-0.5 font-mono text-[10px] text-ink-dim">
          <div style={{ color: CH_COLORS[0] }}>CH1 {fmtMeasure(readout.m[0])}</div>
          <div style={{ color: CH_COLORS[1] }}>CH2 {fmtMeasure(readout.m[1])}</div>
          {cfg.math !== "off" && <div style={{ color: MATH_COLOR }}>MATH {fmtMeasure(readout.m[2])}</div>}
          <div className="text-ink-faint">
            {h
              ? `cursor ${h.t >= 0 ? "+" : "−"}${formatEng(Math.abs(h.t), "second", 3)}  CH1 ${h.v[0] === null ? "—" : formatEng(h.v[0], "volt", 3)}  CH2 ${h.v[1] === null ? "—" : formatEng(h.v[1], "volt", 3)}`
              : running
                ? "Hover the screen for cursor read-outs."
                : "Paused — press Play."}
          </div>
        </div>
      </div>

      <div className="w-[340px] shrink-0 space-y-1.5 overflow-y-auto pr-1 font-mono text-[10px] text-ink-dim">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            type="button"
            onClick={stop}
            className={cn("flex h-6 items-center gap-1 border px-2 uppercase", frozen ? "border-neon-red/70 bg-neon-red/10 text-neon-red" : "border-bg-line text-ink hover:bg-bg-raised")}
          >
            <Square className="h-3 w-3" /> {frozen ? "Run" : "Stop"}
          </button>
          <button type="button" onClick={auto} className="flex h-6 items-center gap-1 border border-bg-line px-2 uppercase text-ink hover:bg-bg-raised" title="Pick time base, volts/div and position automatically">
            <Wand2 className="h-3 w-3" /> Auto
          </button>
          <button
            type="button"
            onClick={() => {
              probes().get(comp.id)?.clear();
              setFrozen(null);
            }}
            className="flex h-6 items-center gap-1 border border-bg-line px-2 uppercase text-ink hover:bg-bg-raised"
            title="Clear captured samples"
          >
            <Eraser className="h-3 w-3" /> Clear
          </button>
          <button
            type="button"
            onClick={() => {
              const c = canvasRef.current;
              if (!c) return;
              const a = document.createElement("a");
              a.href = c.toDataURL("image/png");
              a.download = `${comp.label}-scope.png`;
              a.click();
            }}
            className="flex h-6 items-center gap-1 border border-bg-line px-2 uppercase text-ink hover:bg-bg-raised"
            title="Save the screen as PNG"
          >
            <Camera className="h-3 w-3" /> PNG
          </button>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-12 text-ink-faint">TIME</span>
          <LadderSelect value={cfg.tdiv} values={tladder} family="second" suffix="/div" onChange={(v) => set({ tdiv: v })} />
          <Seg value={cfg.xy ? "xy" : "yt"} options={[["yt", "Y–T"], ["xy", "X–Y"]]} onChange={(v) => set({ display: v })} />
        </div>
        {channel(0)}
        {channel(1)}
        <div className="flex flex-wrap items-center gap-2 border-t border-bg-line pt-1.5">
          <span className="w-12 text-neon-amber">TRIG</span>
          <Seg value={cfg.trigSrc === 0 ? "ch1" : "ch2"} options={[["ch1", "CH1"], ["ch2", "CH2"]]} onChange={(v) => set({ trigSrc: v })} />
          <Seg value={cfg.trigRising ? "rise" : "fall"} options={[["rise", "↑"], ["fall", "↓"]]} onChange={(v) => set({ trigEdge: v })} />
          <Seg value={cfg.trigAuto ? "auto" : "normal"} options={[["auto", "Auto"], ["normal", "Norm"]]} onChange={(v) => set({ trigMode: v })} />
        </div>
        <div className="flex items-center gap-2">
          <span className="w-12 text-ink-faint">LEVEL</span>
          <label className="flex items-center gap-1">
            <input type="checkbox" checked={cfg.autoLevel} onChange={(e) => set({ autoLevel: e.target.checked })} /> mid
          </label>
          {!cfg.autoLevel && <LevelField value={Number(p.trigger ?? 0)} onCommit={(v) => set({ trigger: v })} />}
        </div>
        <div className="flex items-center gap-2 border-t border-bg-line pt-1.5">
          <span className="w-12 text-ink-faint">MATH</span>
          <select
            value={cfg.math}
            onChange={(e) => set({ math: e.target.value })}
            className="h-6 border border-bg-line bg-bg px-1 text-[11px]"
            style={{ color: MATH_COLOR }}
          >
            <option value="off">Off</option>
            <option value="add">CH1 + CH2</option>
            <option value="sub">CH1 − CH2</option>
            <option value="mul">CH1 × CH2</option>
          </select>
        </div>
        <div className="text-ink-faint">
          {readout.sweep ? (readout.sweep.triggered ? "Triggered. " : "No trigger event — free-running. ") : ""}
          X–Y plots the last screen of CH1 (X) against CH2 (Y).
        </div>
      </div>
    </div>
  );
}

// ───────────────────────── logic analyser ─────────────────────────

function LogicView({ comp }: { comp: PlacedComponent }): React.JSX.Element {
  const update = useCircuitStore((s) => s.updateParams);
  const tick = useSimStore((s) => s.tick);
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.max(1, rect.width * dpr);
    canvas.height = Math.max(1, rect.height * dpr);
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const W = rect.width;
    const H = rect.height;
    ctx.fillStyle = "#050f09";
    ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = "rgba(57,255,136,0.16)";
    ctx.lineWidth = 1;
    for (let i = 0; i <= 10; i++) {
      const x = Math.round((W * i) / 10) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, H);
      ctx.stroke();
    }
    const buf = probes().get(comp.id);
    const span = (Number(comp.params.tdiv) || 1e-3) * 10;
    const th = Number(comp.params.threshold) || 1.6;
    if (buf && buf.count > 1) {
      const t1 = buf.timeAt(buf.count - 1);
      const t0 = t1 - span;
      const i0 = buf.lowerBound(t0);
      for (let ch = 0; ch < 8; ch++) {
        const base = ((ch + 0.8) * H) / 8;
        ctx.strokeStyle = LOGIC_COLORS[ch]!;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        let started = false;
        let prev = 0;
        for (let i = Math.max(0, i0 - 1); i < buf.count; i++) {
          const idx = buf.idx(i);
          const x = ((buf.t[idx]! - t0) / span) * W;
          const y = buf.ch[ch]![idx]! > th ? base - H / 12 : base;
          if (!started) {
            ctx.moveTo(x, y);
            started = true;
          } else {
            if (y !== prev) ctx.lineTo(x, prev);
            ctx.lineTo(x, y);
          }
          prev = y;
        }
        ctx.stroke();
        ctx.fillStyle = LOGIC_COLORS[ch]!;
        ctx.font = "10px ui-monospace, Menlo, Consolas, monospace";
        ctx.fillText(`D${ch}`, 4, base - 3);
      }
    } else {
      ctx.fillStyle = "rgba(57,255,136,0.6)";
      ctx.font = "12px ui-monospace, Menlo, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText("NO SIGNAL — press Play", W / 2, H / 2 - 10);
    }
  }, [tick, comp]);

  const field = (label: string, key: string, family: "volt" | "second"): React.JSX.Element => (
    <label className="block">
      <span className="mb-0.5 block uppercase tracking-wider">{label}</span>
      <SciInput value={Number(comp.params[key])} family={family} onCommit={(v) => update(comp.id, { [key]: v })} />
    </label>
  );
  return (
    <div className="flex h-full min-w-0 flex-1 gap-3">
      <canvas ref={ref} className="h-full min-h-0 w-full min-w-0 flex-1 border border-bg-line" />
      <div className="w-[200px] shrink-0 space-y-2 overflow-y-auto font-mono text-[10px] text-ink-dim">
        {field("Threshold", "threshold", "volt")}
        {field("Time/div", "tdiv", "second")}
      </div>
    </div>
  );
}

function SciInput({ value, family, onCommit }: { value: number; family: "volt" | "second"; onCommit: (v: number) => void }): React.JSX.Element {
  const [text, setText] = useState(formatEng(value, family, 3));
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setText(formatEng(value, family, 3));
  }
  const commit = (): void => {
    const v = parseEng(text);
    if (Number.isFinite(v) && v > 0) onCommit(v);
    else setText(formatEng(value, family, 3));
  };
  return <Input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />;
}

// ───────────────────────── dock tab ─────────────────────────

export function InstrumentsView(): React.JSX.Element | null {
  const comps = useCircuitStore((s) => s.components);
  const instruments = comps.filter((c) => c.kind === "scope" || c.kind === "logic_analyzer");
  const [sel, setSel] = useState<string | null>(null);
  const current = instruments.find((c) => c.id === sel) ?? instruments[0];

  if (!current) return <div className="p-3 font-mono text-[11px] text-ink-faint">No oscilloscope or logic analyzer in the circuit.</div>;

  return (
    <div className="flex h-full flex-col p-2">
      {instruments.length > 1 && (
        <select
          value={current.id}
          onChange={(e) => setSel(e.target.value)}
          className="mb-1 h-6 w-48 border border-bg-line bg-bg px-1 font-mono text-[11px] text-ink"
        >
          {instruments.map((i) => (
            <option key={i.id} value={i.id}>{i.label}</option>
          ))}
        </select>
      )}
      <div className="min-h-0 flex-1">
        {current.kind === "scope" ? <ScopeView key={current.id} comp={current} /> : <LogicView key={current.id} comp={current} />}
      </div>
    </div>
  );
}
