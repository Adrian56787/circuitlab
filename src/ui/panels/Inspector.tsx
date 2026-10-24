"use client";

import { Code2, Copy, FlipHorizontal2, Palette, RotateCw, Trash2, Wrench } from "lucide-react";
import { useState, useSyncExternalStore } from "react";
import { getDef } from "@/models/catalog";
import { resistanceToBands } from "@/models/resistorColor";
import { isAdvancedField } from "@/models/viewMode";
import { useSettingsStore } from "@/store/settingsStore";
import { HelpCard } from "./HelpCard";
import type { ComponentSnapshot, ParamField, PlacedComponent, Wire, WireColor } from "@/models/types";
import { UNIT_CHOICES, UNIT_SYMBOL, formatEng, parseEng, prefixExp, splitEng } from "@/models/units";
import { getLive, burnTimes, sim } from "@/engine/runtime";
import { getIo } from "@/mcu/io";
import { sourceValue } from "@/engine/devices";
import { cn } from "@/lib/utils";
import { useCircuitStore } from "@/store/circuitStore";
import { useSimStore } from "@/store/simulationStore";
import { useUiStore } from "@/store/uiStore";
import { Button } from "../primitives/button";
import { Input, Select } from "../primitives/input";
import { ResistorBody } from "./ResistorCalc";

type NumberField = Extract<ParamField, { type: "number" }>;

const clamp = (v: number, lo?: number, hi?: number): number => Math.min(hi ?? Infinity, Math.max(lo ?? -Infinity, v));

/** E12 preferred values, used by the ↑ / ↓ keys. */
const E12 = [1, 1.2, 1.5, 1.8, 2.2, 2.7, 3.3, 3.9, 4.7, 5.6, 6.8, 8.2];

/** Next / previous standard (E12) value around `v`. */
function stepE12(v: number, dir: 1 | -1): number {
  if (!(v > 0)) return dir > 0 ? 1 : v;
  const exp = Math.floor(Math.log10(v));
  const m = v / 10 ** exp;
  const scale = [...E12, 10];
  if (dir > 0) {
    const n = scale.find((x) => x > m * 1.0001) ?? 10;
    return Number((n * 10 ** exp).toPrecision(3));
  }
  const lower = scale.filter((x) => x < m * 0.9999);
  const n = lower.length ? lower[lower.length - 1]! : 8.2 / 10;
  return Number((n * 10 ** exp).toPrecision(3));
}

const PLAIN_NUMBER = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?$/i;

/**
 * Numeric field with direct keyboard entry. Type a plain number (the unit menu supplies the prefix) or a full value
 * with engineering notation — "4.7k", "100uF", "2.2n", "4k7", "1e-6", "47meg". Enter applies, Esc cancels, ↑/↓ step
 * through standard E12 values.
 */
function NumberEditor({ field, value, onChange }: { field: NumberField; value: number; onChange: (v: number) => void }): React.JSX.Element {
  const choices = UNIT_CHOICES[field.unit];
  const eng = splitEng(value);
  const prefix = choices.includes(eng.prefix) ? eng.prefix : choices.includes("") ? "" : (choices[0] ?? "");
  const mant = choices.includes(eng.prefix) ? eng.mantissa : Number((value / 10 ** prefixExp(prefix)).toPrecision(6));
  const [text, setText] = useState(String(mant));
  const [synced, setSynced] = useState(value);
  const [err, setErr] = useState<string | null>(null);
  const notify = useUiStore((s) => s.notify);
  if (synced !== value) {
    setSynced(value);
    setText(String(mant));
    setErr(null);
  }

  /** Apply `t` (typed text) with unit-menu prefix `p`; returns false when the text is not a number. */
  const commit = (t: string, p: string): boolean => {
    const raw = t.trim();
    if (raw === "") {
      setText(String(mant));
      setErr(null);
      return true;
    }
    const n = PLAIN_NUMBER.test(raw) ? Number(raw) * 10 ** prefixExp(p) : parseEng(raw);
    if (!Number.isFinite(n)) {
      setErr(`Can't read “${raw}”. Try 4.7k, 100n, 2.2u or 1e-3.`);
      return false;
    }
    const v = clamp(n, field.min, field.max);
    if (v !== n) notify(`${field.label} limited to ${formatEng(v, field.unit)} (allowed ${field.min !== undefined ? formatEng(field.min, field.unit) : "−∞"} … ${field.max !== undefined ? formatEng(field.max, field.unit) : "∞"}).`, "warn");
    setErr(null);
    if (v === value) setText(String(mant));
    else onChange(v);
    return true;
  };

  const step = (dir: 1 | -1): void => {
    const raw = text.trim();
    const cur = raw === "" ? value : PLAIN_NUMBER.test(raw) ? Number(raw) * 10 ** prefixExp(prefix) : parseEng(raw);
    const base = Number.isFinite(cur) ? cur : value;
    const v = clamp(stepE12(base, dir), field.min, field.max);
    setErr(null);
    onChange(v);
  };

  return (
    <div>
      <div className="flex gap-1">
        <Input
          value={text}
          inputMode="text"
          spellCheck={false}
          autoComplete="off"
          placeholder="e.g. 4.7k"
          onChange={(e) => {
            setText(e.target.value);
            setErr(null);
          }}
          onFocus={(e) => e.target.select()}
          onBlur={() => {
            if (!commit(text, prefix)) setText(String(mant));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              if (commit(text, prefix)) (e.target as HTMLInputElement).blur();
            } else if (e.key === "Escape") {
              setText(String(mant));
              setErr(null);
              (e.target as HTMLInputElement).blur();
            } else if (e.key === "ArrowUp" || e.key === "ArrowDown") {
              e.preventDefault();
              step(e.key === "ArrowUp" ? 1 : -1);
            }
          }}
          aria-label={field.label}
          aria-invalid={err !== null}
          title="Type a value: 4.7k, 100n, 2.2u, 4k7, 1e-6 … (↑ ↓ = next standard value)"
          className={cn("min-w-0 flex-1", err && "border-neon-red/80 text-neon-red")}
        />
        {choices.length > 1 || field.unit !== "none" ? (
          <Select
            value={prefix}
            onChange={(e) => {
              const p = e.target.value;
              // same number, new prefix (when the text holds a bare number); a full typed value keeps its own
              const raw = text.trim();
              if (PLAIN_NUMBER.test(raw)) commit(raw, p);
              else commit(raw || String(mant), p);
            }}
            aria-label={`${field.label} unit`}
            className="w-[68px] shrink-0"
          >
            {choices.map((p) => (
              <option key={p} value={p}>
                {p}
                {UNIT_SYMBOL[field.unit]}
              </option>
            ))}
          </Select>
        ) : null}
      </div>
      {err && (
        <div role="alert" className="mt-0.5 text-[10px] text-neon-red">
          {err}
        </div>
      )}
    </div>
  );
}

/** Small typed-value box next to a slider (exact value, engineering notation allowed). */
function SliderValue({ field, value, onChange }: { field: Extract<ParamField, { type: "slider" }>; value: number; onChange: (v: number) => void }): React.JSX.Element {
  const [text, setText] = useState(String(value));
  const [synced, setSynced] = useState(value);
  const [bad, setBad] = useState(false);
  if (synced !== value) {
    setSynced(value);
    setText(String(value));
    setBad(false);
  }
  const commit = (): void => {
    const n = parseEng(text);
    if (!Number.isFinite(n)) {
      setBad(true);
      setText(String(value));
      return;
    }
    setBad(false);
    const v = clamp(n, field.min, field.max);
    setText(String(v));
    if (v !== value) onChange(v);
  };
  return (
    <Input
      value={text}
      inputMode="decimal"
      aria-label={`${field.label} value`}
      title={`Type an exact value (${field.min} … ${field.max})`}
      onChange={(e) => setText(e.target.value)}
      onFocus={(e) => e.target.select()}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.target as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setText(String(value));
          (e.target as HTMLInputElement).blur();
        }
      }}
      className={cn("w-16 shrink-0 text-right text-neon-cyan", bad && "border-neon-red/80")}
    />
  );
}

function FieldRow({ comp, field }: { comp: PlacedComponent; field: ParamField }): React.JSX.Element {
  const update = useCircuitStore((s) => s.updateParams);
  const raw = comp.params[field.key];
  const key = `${comp.id}:${field.key}`;

  let control: React.JSX.Element;
  switch (field.type) {
    case "number":
      control = <NumberEditor field={field} value={typeof raw === "number" ? raw : 0} onChange={(v) => update(comp.id, { [field.key]: v })} />;
      break;
    case "select":
      control = (
        <Select value={String(raw ?? "")} onChange={(e) => update(comp.id, { [field.key]: e.target.value })} className="w-full">
          {field.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      );
      break;
    case "boolean":
      control = (
        <input type="checkbox" checked={raw === true} onChange={(e) => update(comp.id, { [field.key]: e.target.checked })} className="h-4 w-4 accent-neon-cyan" />
      );
      break;
    case "slider":
      control = (
        <div className="flex items-center gap-2">
          <input
            type="range"
            min={field.min}
            max={field.max}
            step={field.step}
            value={typeof raw === "number" ? raw : field.min}
            onChange={(e) => update(comp.id, { [field.key]: Number(e.target.value) }, key)}
            className="h-1 min-w-0 flex-1 accent-neon-cyan"
          />
          <SliderValue field={field} value={typeof raw === "number" ? raw : field.min} onChange={(v) => update(comp.id, { [field.key]: v })} />
        </div>
      );
      break;
    default:
      control = <Input value={String(raw ?? "")} onChange={(e) => update(comp.id, { [field.key]: e.target.value }, key)} />;
  }

  return (
    <label className="block">
      <span className="mb-0.5 block font-mono text-[10px] uppercase tracking-wider text-ink-dim">{field.label}</span>
      {control}
      {"help" in field && field.help && <span className="mt-0.5 block text-[10px] text-ink-faint">{field.help}</span>}
    </label>
  );
}

function Readout({ snap }: { snap: ComponentSnapshot }): React.JSX.Element {
  const pct = Math.min(1.5, snap.stress) * 100;
  const hot = snap.stress > 1;
  return (
    <div className="space-y-1.5 border border-bg-line bg-bg p-2 font-mono text-[11px]">
      <div className="grid grid-cols-3 gap-2">
        <div>
          <div className="text-[9px] uppercase text-ink-faint">Voltage</div>
          <div className="text-neon-cyan">{formatEng(snap.voltage, "volt", 3)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase text-ink-faint">Current</div>
          <div className="text-neon-green">{formatEng(snap.current, "amp", 3)}</div>
        </div>
        <div>
          <div className="text-[9px] uppercase text-ink-faint">Power</div>
          <div className="text-neon-amber">{formatEng(Math.abs(snap.power), "watt", 3)}</div>
        </div>
      </div>
      <div>
        <div className="mb-0.5 flex justify-between text-[9px] uppercase text-ink-faint">
          <span>Load vs. rating</span>
          <span className={hot ? "text-neon-red" : ""}>{(snap.stress * 100).toFixed(0)}%</span>
        </div>
        <div className="h-1.5 w-full bg-bg-line">
          <div
            className={cn("h-full transition-[width]", snap.stress > 1 ? "bg-neon-red" : snap.stress > 0.7 ? "bg-neon-amber" : "bg-neon-green")}
            style={{ width: `${Math.min(100, pct / 1.5)}%` }}
          />
        </div>
      </div>
    </div>
  );
}

function ComponentInspector({ comp }: { comp: PlacedComponent }): React.JSX.Element {
  const def = getDef(comp.kind);
  const setLabel = useCircuitStore((s) => s.setLabel);
  const rotate = useCircuitStore((s) => s.rotateSelection);
  const mirror = useCircuitStore((s) => s.mirrorSelection);
  const dup = useCircuitStore((s) => s.duplicateSelection);
  const del = useCircuitStore((s) => s.deleteSelection);
  const setCalc = useUiStore((s) => s.setColorCalcOpen);
  const bump = useSimStore((s) => s.bump);
  useSimStore((s) => s.tick); // re-read live data ~10×/s
  const snap = getLive()?.components[comp.id];
  const viewMode = useSettingsStore((s) => s.viewMode);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const fields = viewMode === "simple" ? def.fields.filter((f) => !isAdvancedField(f)) : def.fields;
  const hiddenFields = def.fields.length - fields.length;

  const bands =
    comp.kind === "resistor"
      ? resistanceToBands(Number(comp.params.resistance) || 0, Number(comp.params.tolerance) || 5, false).bands
      : null;

  return (
    <div className="space-y-3 p-3">
      <div>
        <div className="panel-title">{def.category}</div>
        <div className="font-mono text-sm text-ink">{def.name}</div>
        <div className="mt-0.5 text-[11px] leading-snug text-ink-faint">{def.description}</div>
      </div>

      <div className="flex gap-1">
        <Button size="icon" onClick={rotate} title="Rotate 90° (R)"><RotateCw className="h-3.5 w-3.5" /></Button>
        <Button size="icon" onClick={mirror} title="Mirror (F)"><FlipHorizontal2 className="h-3.5 w-3.5" /></Button>
        <Button size="icon" onClick={dup} title="Duplicate (Ctrl+D)"><Copy className="h-3.5 w-3.5" /></Button>
        <Button size="icon" variant="danger" onClick={del} title="Delete (Del)"><Trash2 className="h-3.5 w-3.5" /></Button>
      </div>

      <label className="block">
        <span className="mb-0.5 block font-mono text-[10px] uppercase tracking-wider text-ink-dim">Designator</span>
        <Input defaultValue={comp.label} key={comp.id + comp.label} onBlur={(e) => e.target.value.trim() && e.target.value !== comp.label && setLabel(comp.id, e.target.value.trim())} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
      </label>

      {bands && (
        <div className="border border-bg-line bg-bg p-2">
          <ResistorBody bands={bands} className="h-10 w-full" />
          <Button className="mt-2 w-full" onClick={() => setCalc(true)}>
            <Palette className="h-3.5 w-3.5" /> Colour-code calculator
          </Button>
        </div>
      )}

      {snap && (
        <>
          {snap.burned ? (
            <div className="space-y-2 border border-neon-red/60 bg-neon-red/10 p-2 font-mono text-[11px] text-neon-red">
              <div className="font-bold uppercase tracking-wider">Component destroyed</div>
              <p className="whitespace-normal font-sans text-[12px] leading-snug text-ink">
                {snap.failure ?? "It was driven beyond its rated limits for too long."}
              </p>
              <Button
                variant="danger"
                size="sm"
                onClick={() => {
                  sim.repair(comp.id);
                  burnTimes.delete(comp.id);
                  bump();
                }}
              >
                <Wrench className="h-3.5 w-3.5" /> Replace part
              </Button>
            </div>
          ) : null}
          <Readout snap={snap} />
          {def.sim === "transformer" && <TransformerReadout snap={snap} />}
        </>
      )}

      {def.fields.length > 0 && (
        <div className="space-y-2.5">
          <div className="flex items-center justify-between">
            <div className="panel-title">Parameters</div>
            <span className="font-mono text-[9px] uppercase tracking-wider text-ink-faint">{viewMode} view</span>
          </div>
          {fields.map((f) => (
            <FieldRow key={f.key} comp={comp} field={f} />
          ))}
          {hiddenFields > 0 && (
            <button
              type="button"
              onClick={() => setViewMode("advanced")}
              className="w-full border border-dashed border-bg-line px-2 py-1.5 text-left font-mono text-[10px] text-ink-faint hover:border-neon-cyan/60 hover:text-neon-cyan"
            >
              {hiddenFields} advanced {hiddenFields === 1 ? "parameter" : "parameters"} hidden — switch to Advanced view
            </button>
          )}
        </div>
      )}

      <details key={comp.kind} open={viewMode === "simple"} className="group border border-bg-line bg-bg">
        <summary className="cursor-pointer select-none px-2 py-1.5 font-mono text-[10px] uppercase tracking-wider text-neon-cyan hover:bg-bg-raised">
          About this part
        </summary>
        <div className="border-t border-bg-line p-2">
          <HelpCard kind={comp.kind} />
        </div>
      </details>

      {(comp.kind === "vac" || comp.kind === "sigen") && <WaveSummary comp={comp} />}
      {def.sim === "mcu" && <McuBlock id={comp.id} />}
      {def.sim === "none" && def.category !== "instrument" && def.kind !== "ground" && (
        <div className="border border-neon-amber/40 bg-neon-amber/5 p-2 text-[11px] text-neon-amber">
          Drawn and wireable; electrical model not simulated in this build.
        </div>
      )}
      {(comp.kind === "toggle_switch" || comp.kind === "pushbutton" || comp.kind === "dip_switch") && (
        <div className="text-[11px] text-ink-faint">While the simulation is running, click the part on the canvas to operate it.</div>
      )}
    </div>
  );
}

/** Peak / RMS / mean / Vpp of a generator, computed by sampling one period of its waveform. */
function WaveSummary({ comp }: { comp: PlacedComponent }): React.JSX.Element {
  const f = Math.max(1e-6, Number(comp.params.frequency) || 1);
  const N = 2000;
  let lo = Infinity;
  let hi = -Infinity;
  let sum = 0;
  let sq = 0;
  for (let i = 0; i < N; i++) {
    const v = sourceValue(comp, (i + 0.5) / N / f);
    lo = Math.min(lo, v);
    hi = Math.max(hi, v);
    sum += v;
    sq += v * v;
  }
  const mean = sum / N;
  const rms = Math.sqrt(sq / N);
  const cell = (label: string, text: string): React.JSX.Element => (
    <div>
      <div className="text-[9px] uppercase text-ink-faint">{label}</div>
      <div className="text-neon-cyan">{text}</div>
    </div>
  );
  return (
    <div className="space-y-1.5 border border-bg-line bg-bg p-2 font-mono text-[11px]">
      <div className="text-[9px] uppercase tracking-wider text-ink-faint">Waveform summary</div>
      <div className="grid grid-cols-3 gap-2">
        {cell("Max", formatEng(hi, "volt", 3))}
        {cell("Min", formatEng(lo, "volt", 3))}
        {cell("Vpp", formatEng(hi - lo, "volt", 3))}
        {cell("Mean (DC)", formatEng(mean, "volt", 3))}
        {cell("RMS", formatEng(rms, "volt", 3))}
        {cell("Period", formatEng(1 / f, "second", 3))}
      </div>
    </div>
  );
}

function TransformerReadout({ snap }: { snap: ComponentSnapshot }): React.JSX.Element {
  const a = snap.aux;
  const cell = (label: string, text: string, cls = "text-neon-cyan"): React.JSX.Element => (
    <div>
      <div className="text-[9px] uppercase text-ink-faint">{label}</div>
      <div className={cls}>{text}</div>
    </div>
  );
  const ratio = (a.vpRms ?? 0) > 1e-6 ? (a.vsRms ?? 0) / (a.vpRms ?? 1) : 0;
  return (
    <div className="space-y-1.5 border border-bg-line bg-bg p-2 font-mono text-[11px]">
      <div className="text-[9px] uppercase tracking-wider text-ink-faint">AC read-outs (true RMS)</div>
      <div className="grid grid-cols-3 gap-2">
        {cell("Primary V", formatEng(a.vpRms ?? 0, "volt", 3))}
        {cell("Secondary V", formatEng(a.vsRms ?? 0, "volt", 3))}
        {cell("Vs / Vp", ratio ? ratio.toFixed(3) : "—")}
        {cell("Primary I", formatEng(a.ipRms ?? 0, "amp", 3), "text-neon-green")}
        {cell("Secondary I", formatEng(a.isRms ?? 0, "amp", 3), "text-neon-green")}
        {cell("Efficiency", (a.pin ?? 0) > 1e-4 ? `${((a.eff ?? 0) * 100).toFixed(1)} %` : "—", "text-neon-amber")}
        {cell("P in", formatEng(a.pin ?? 0, "watt", 3), "text-neon-amber")}
        {cell("P out", formatEng(a.pout ?? 0, "watt", 3), "text-neon-amber")}
      </div>
    </div>
  );
}

function McuBlock({ id }: { id: string }): React.JSX.Element {
  const openCode = useUiStore((s) => s.openCode);
  const io = getIo(id);
  useSyncExternalStore(
    (fn) => io.subscribe(fn),
    () => io.version,
    () => 0,
  );
  const st = io.status;
  return (
    <div className="space-y-2 border border-bg-line bg-bg p-2 text-[11px] leading-snug text-ink-dim">
      <Button variant="primary" className="w-full" onClick={() => openCode(id)}>
        <Code2 className="h-3.5 w-3.5" /> Edit code
      </Button>
      <div className={cn("font-mono", st.kind === "running" ? "text-neon-cyan" : st.kind === "error" ? "text-neon-red" : "text-ink-faint")}>
        {st.kind === "running" ? "● Running sketch" : st.kind === "error" ? `✕ ${st.message}` : st.kind === "off" ? "○ Not powered" : "Idle — press Run"}
      </div>
    </div>
  );
}

const WIRE_COLORS: { id: WireColor; label: string; hex: string }[] = [
  { id: "auto", label: "Auto", hex: "linear-gradient(90deg,#ff4d5e 33%,#ffd23f 33% 66%,#7d8794 66%)" },
  { id: "vcc", label: "VCC", hex: "#ff4d5e" },
  { id: "gnd", label: "GND", hex: "#7d8794" },
  { id: "signal", label: "Signal", hex: "#ffd23f" },
];

function WireInspector({ wire }: { wire: Wire }): React.JSX.Element {
  const setColor = useCircuitStore((s) => s.setWireColor);
  const setRouting = useCircuitStore((s) => s.setWireRouting);
  const del = useCircuitStore((s) => s.deleteSelection);
  const comps = useCircuitStore((s) => s.components);
  const label = (id: string, pin: string): string => `${comps.find((c) => c.id === id)?.label ?? "?"}.${pin}`;
  useSimStore((s) => s.tick);
  const i = getLive()?.wireCurrent[wire.id];
  return (
    <div className="space-y-3 p-3">
      <div>
        <div className="panel-title">Wire</div>
        <div className="font-mono text-sm text-ink">
          {label(wire.from.componentId, wire.from.pinId)} → {label(wire.to.componentId, wire.to.pinId)}
        </div>
        {i !== undefined && <div className="mt-1 font-mono text-[11px] text-neon-green">{formatEng(i, "amp", 3)}</div>}
      </div>
      <div>
        <div className="panel-title mb-1">Colour</div>
        <div className="flex flex-wrap gap-1">
          {WIRE_COLORS.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => setColor(wire.id, c.id)}
              className={cn("flex items-center gap-1.5 border px-2 py-1 font-mono text-[10px] uppercase", wire.color === c.id ? "border-neon-cyan text-neon-cyan" : "border-bg-line text-ink-dim hover:border-ink-faint")}
            >
              <span className="h-2.5 w-2.5" style={{ background: c.hex }} />
              {c.label}
            </button>
          ))}
          <label className={cn("flex items-center gap-1.5 border px-2 py-1 font-mono text-[10px] uppercase", wire.color === "custom" ? "border-neon-cyan text-neon-cyan" : "border-bg-line text-ink-dim")}>
            Custom
            <input type="color" value={wire.custom ?? "#39ff88"} onChange={(e) => setColor(wire.id, "custom", e.target.value)} className="h-4 w-5 border-0 bg-transparent p-0" />
          </label>
        </div>
      </div>
      <div>
        <div className="panel-title mb-1">Routing</div>
        <div className="flex gap-1">
          <Button variant={wire.routing === "orthogonal" ? "active" : "default"} size="sm" onClick={() => setRouting(wire.id, "orthogonal")}>Orthogonal</Button>
          <Button variant={wire.routing === "bezier" ? "active" : "default"} size="sm" onClick={() => setRouting(wire.id, "bezier")}>Bézier</Button>
        </div>
      </div>
      <Button variant="danger" onClick={del}>
        <Trash2 className="h-3.5 w-3.5" /> Delete wire
      </Button>
    </div>
  );
}

function Overview(): React.JSX.Element {
  const name = useCircuitStore((s) => s.name);
  const comps = useCircuitStore((s) => s.components.length);
  const wires = useCircuitStore((s) => s.wires.length);
  useSimStore((s) => s.tick);
  const diag = getLive()?.diagnostics;
  return (
    <div className="space-y-3 p-3">
      <div>
        <div className="panel-title">Circuit</div>
        <Input
          className="mt-1"
          defaultValue={name}
          key={name}
          onBlur={(e) => useCircuitStore.setState({ name: e.target.value.trim() || "Untitled circuit" })}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
        />
        <div className="mt-1 font-mono text-[11px] text-ink-dim">
          {comps} parts · {wires} wires
        </div>
      </div>
      {diag && diag.messages.length > 0 && (
        <div className="space-y-1 border border-neon-amber/40 bg-neon-amber/5 p-2 text-[11px] text-neon-amber">
          {diag.messages.map((m, i) => (
            <div key={i}>{m}</div>
          ))}
        </div>
      )}
      <div>
        <div className="panel-title mb-1">Shortcuts</div>
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 font-mono text-[11px] text-ink-dim">
          {[
            ["V / W", "Select / wire tool"],
            ["R / F", "Rotate / flip part"],
            ["Del", "Delete selection"],
            ["Ctrl+Z / Y", "Undo / redo"],
            ["Ctrl+D", "Duplicate"],
            ["Space+drag", "Pan (or middle mouse)"],
            ["Wheel", "Zoom at cursor"],
            ["G", "Cycle grid style"],
            ["Esc", "Cancel / deselect"],
            ["Right-click", "Inspect part or wire"],
          ].map(([k, v]) => (
            <div key={k} className="contents">
              <dt><span className="kbd">{k}</span></dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>
      </div>
      <div className="text-[11px] leading-snug text-ink-faint">
        Click a pin to start a wire, click another pin to finish it. Every circuit needs a GND symbol; without one the first source’s negative terminal is used as 0 V.
      </div>
    </div>
  );
}

export function Inspector(): React.JSX.Element {
  const selection = useCircuitStore((s) => s.selection);
  const comps = useCircuitStore((s) => s.components);
  const wires = useCircuitStore((s) => s.wires);

  let body: React.JSX.Element;
  if (selection.components.length === 1) {
    const c = comps.find((x) => x.id === selection.components[0]);
    body = c ? <ComponentInspector comp={c} /> : <Overview />;
  } else if (selection.components.length === 0 && selection.wires.length === 1) {
    const w = wires.find((x) => x.id === selection.wires[0]);
    body = w ? <WireInspector wire={w} /> : <Overview />;
  } else if (selection.components.length + selection.wires.length > 1) {
    body = (
      <div className="p-3 font-mono text-[11px] text-ink-dim">
        {selection.components.length} parts, {selection.wires.length} wires selected.
        <div className="mt-2 text-ink-faint">Drag to move · R rotate · Del delete · Ctrl+D duplicate</div>
      </div>
    );
  } else {
    body = <Overview />;
  }

  return (
    <aside className="flex h-full w-[290px] shrink-0 flex-col border-l border-bg-line bg-bg-panel">
      <div className="panel-title border-b border-bg-line px-3 py-2">Inspector</div>
      <div className="min-h-0 flex-1 overflow-y-auto">{body}</div>
    </aside>
  );
}
