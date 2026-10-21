"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { probes } from "@/engine/probes";
import { formatEng } from "@/models/units";
import { useCircuitStore } from "@/store/circuitStore";
import { useSimStore } from "@/store/simulationStore";
import { useUiStore } from "@/store/uiStore";
import { Input } from "../primitives/input";

const CH_COLORS = ["#ffe62a", "#2fd8ff"];
const LOGIC_COLORS = ["#ff4d5e", "#ffb020", "#ffe62a", "#39ff88", "#2fd8ff", "#4d8dff", "#b38bff", "#ff7ad9"];

function ScopeScreen({ id, logic }: { id: string; logic: boolean }): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);
  const tick = useSimStore((s) => s.tick);
  const comp = useCircuitStore((s) => s.components.find((c) => c.id === id));
  const [stats, setStats] = useState<string[]>([]);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas || !comp) return;
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
    for (let j = 0; j <= 8; j++) {
      const y = Math.round((H * j) / 8) + 0.5;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(W, y);
      ctx.stroke();
    }
    ctx.strokeStyle = "rgba(57,255,136,0.38)";
    ctx.beginPath();
    ctx.moveTo(0, H / 2);
    ctx.lineTo(W, H / 2);
    ctx.moveTo(W / 2, 0);
    ctx.lineTo(W / 2, H);
    ctx.stroke();

    const buf = probes().get(id);
    const tdiv = Number(comp.params.tdiv) || 1e-3;
    const span = tdiv * 10;
    const out: string[] = [];
    if (buf && buf.count > 1) {
      const t1 = buf.at(buf.count - 1).t;
      const t0 = t1 - span;
      if (!logic) {
        // trigger: find a rising crossing of CH1 near the left edge for a stable picture
        for (let ch = 0; ch < 2; ch++) {
          const vdiv = Number(comp.params[ch === 0 ? "vdiv1" : "vdiv2"]) || 1;
          ctx.strokeStyle = CH_COLORS[ch]!;
          ctx.lineWidth = 1.6;
          ctx.beginPath();
          let started = false;
          let vmin = Infinity;
          let vmax = -Infinity;
          let sum = 0;
          let n = 0;
          for (let i = 0; i < buf.count; i++) {
            const s = buf.at(i);
            if (s.t < t0) continue;
            const v = s.v(ch);
            vmin = Math.min(vmin, v);
            vmax = Math.max(vmax, v);
            sum += v;
            n++;
            const x = ((s.t - t0) / span) * W;
            const y = H / 2 - (v / vdiv) * (H / 8);
            if (!started) {
              ctx.moveTo(x, y);
              started = true;
            } else ctx.lineTo(x, y);
          }
          ctx.stroke();
          if (n > 0) out.push(`CH${ch + 1}  Vpp ${formatEng(vmax - vmin, "volt", 3)}  mean ${formatEng(sum / n, "volt", 3)}  max ${formatEng(vmax, "volt", 3)}`);
        }
      } else {
        const th = Number(comp.params.threshold) || 1.6;
        for (let ch = 0; ch < 8; ch++) {
          const base = ((ch + 0.8) * H) / 8;
          ctx.strokeStyle = LOGIC_COLORS[ch]!;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          let started = false;
          let prev = 0;
          for (let i = 0; i < buf.count; i++) {
            const s = buf.at(i);
            if (s.t < t0) continue;
            const x = ((s.t - t0) / span) * W;
            const y = s.v(ch) > th ? base - H / 12 : base;
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
      }
    } else {
      ctx.fillStyle = "rgba(57,255,136,0.6)";
      ctx.font = "12px ui-monospace, Menlo, Consolas, monospace";
      ctx.textAlign = "center";
      ctx.fillText("NO SIGNAL — press Play", W / 2, H / 2 - 10);
    }
    setStats(out);
  }, [tick, comp, id, logic]);

  return (
    <div className="flex min-w-0 flex-1 flex-col">
      <canvas ref={ref} className="h-full min-h-0 w-full flex-1 border border-bg-line" />
      <div className="flex gap-4 px-1 pt-1 font-mono text-[10px] text-ink-dim">
        {stats.map((s, i) => (
          <span key={i} style={{ color: CH_COLORS[i] }}>{s}</span>
        ))}
      </div>
    </div>
  );
}

export function ScopePanel(): React.JSX.Element | null {
  const open = useUiStore((s) => s.scopeOpen);
  const setOpen = useUiStore((s) => s.setScopeOpen);
  const comps = useCircuitStore((s) => s.components);
  const update = useCircuitStore((s) => s.updateParams);
  const instruments = comps.filter((c) => c.kind === "scope" || c.kind === "logic_analyzer");
  const [sel, setSel] = useState<string | null>(null);
  const current = instruments.find((c) => c.id === sel) ?? instruments[0];

  if (instruments.length === 0) return null;

  return (
    <div className="border-t border-bg-line bg-bg-panel">
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-bg-raised"
      >
        {open ? <ChevronDown className="h-3.5 w-3.5 text-ink-dim" /> : <ChevronUp className="h-3.5 w-3.5 text-ink-dim" />}
        <span className="panel-title !text-ink">Instruments</span>
        <span className="font-mono text-[10px] text-ink-faint">{instruments.map((i) => i.label).join(" · ")}</span>
      </button>
      {open && current && (
        <div className="flex h-[230px] gap-3 border-t border-bg-line p-2">
          <ScopeScreen id={current.id} logic={current.kind === "logic_analyzer"} />
          <div className="w-[200px] shrink-0 space-y-2 overflow-y-auto font-mono text-[10px] text-ink-dim">
            {instruments.length > 1 && (
              <select
                value={current.id}
                onChange={(e) => setSel(e.target.value)}
                className="h-7 w-full border border-bg-line bg-bg px-1 text-[11px] text-ink"
              >
                {instruments.map((i) => (
                  <option key={i.id} value={i.id}>{i.label}</option>
                ))}
              </select>
            )}
            {current.kind === "scope" ? (
              <>
                <SciField label="CH1 volts/div" value={Number(current.params.vdiv1)} unit="V" onCommit={(v) => update(current.id, { vdiv1: v })} />
                <SciField label="CH2 volts/div" value={Number(current.params.vdiv2)} unit="V" onCommit={(v) => update(current.id, { vdiv2: v })} />
                <SciField label="Time/div" value={Number(current.params.tdiv)} unit="s" onCommit={(v) => update(current.id, { tdiv: v })} />
              </>
            ) : (
              <>
                <SciField label="Threshold" value={Number(current.params.threshold)} unit="V" onCommit={(v) => update(current.id, { threshold: v })} />
                <SciField label="Time/div" value={Number(current.params.tdiv)} unit="s" onCommit={(v) => update(current.id, { tdiv: v })} />
              </>
            )}
            <div className="text-ink-faint">Type values like <span className="text-ink-dim">500m</span>, <span className="text-ink-dim">2u</span>, <span className="text-ink-dim">5k</span>.</div>
          </div>
        </div>
      )}
    </div>
  );
}

import { parseEng } from "@/models/units";

function SciField({ label, value, unit, onCommit }: { label: string; value: number; unit: string; onCommit: (v: number) => void }): React.JSX.Element {
  const [text, setText] = useState(formatEng(value, unit === "V" ? "volt" : "second", 3));
  const [synced, setSynced] = useState(value);
  if (synced !== value) {
    setSynced(value);
    setText(formatEng(value, unit === "V" ? "volt" : "second", 3));
  }
  const commit = (): void => {
    const v = parseEng(text);
    if (Number.isFinite(v) && v > 0) onCommit(v);
    else setText(formatEng(value, unit === "V" ? "volt" : "second", 3));
  };
  return (
    <label className="block">
      <span className="mb-0.5 block uppercase tracking-wider">{label}</span>
      <Input value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
    </label>
  );
}
