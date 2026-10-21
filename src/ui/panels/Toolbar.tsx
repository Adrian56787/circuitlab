"use client";

import {
  Activity,
  Cable,
  ChevronDown,
  Eye,
  FileDown,
  FilePlus2,
  FileUp,
  Grid3x3,
  Hand,
  Image as ImageIcon,
  Layers,
  Magnet,
  Maximize,
  MousePointer2,
  Pause,
  Play,
  Redo2,
  RotateCcw,
  SkipForward,
  Undo2,
  Zap,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { componentBBox } from "@/models/geometry";
import { GRID_PX } from "@/models/types";
import { PRESETS, type Preset } from "@/presets/presets";
import { exportJson, exportPng, exportSvg, importJsonFile } from "@/storage/exporters";
import { CircuitFormatError } from "@/storage/serialize";
import { useCircuitStore } from "@/store/circuitStore";
import { sliderFromSpeed, speedFromSlider, useSimStore } from "@/store/simulationStore";
import { useUiStore, type Tool } from "@/store/uiStore";
import { useViewportStore } from "@/store/viewportStore";
import { cn } from "@/lib/utils";
import { Button } from "../primitives/button";

export function fitView(): void {
  const host = document.getElementById("canvas-host");
  const { components } = useCircuitStore.getState();
  const vp = useViewportStore.getState();
  if (!host || components.length === 0) {
    vp.resetView();
    return;
  }
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of components) {
    const b = componentBBox(c);
    x0 = Math.min(x0, b.x0);
    y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1);
    y1 = Math.max(y1, b.y1 + 1);
  }
  const w = host.clientWidth;
  const h = host.clientHeight;
  const pad = 60;
  const zoom = Math.min(1.6, Math.max(0.2, Math.min((w - pad * 2) / ((x1 - x0) * GRID_PX), (h - pad * 2) / ((y1 - y0) * GRID_PX))));
  vp.setZoom(zoom);
  vp.setPan(w / 2 - ((x0 + x1) / 2) * GRID_PX * zoom, h / 2 - ((y0 + y1) / 2) * GRID_PX * zoom);
}

function Menu({ label, icon, children, align = "left" }: { label: string; icon: React.ReactNode; children: (close: () => void) => React.ReactNode; align?: "left" | "right" }): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const h = (e: MouseEvent): void => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener("mousedown", h);
    return () => window.removeEventListener("mousedown", h);
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <Button variant={open ? "active" : "default"} onClick={() => setOpen(!open)} aria-expanded={open}>
        {icon}
        {label}
        <ChevronDown className="h-3 w-3" />
      </Button>
      {open && (
        <div className={cn("absolute top-full z-40 mt-1 min-w-[260px] border border-bg-line bg-bg-panel shadow-2xl", align === "right" ? "right-0" : "left-0")}>
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

function MenuItem({ onClick, children, sub }: { onClick: () => void; children: React.ReactNode; sub?: string }): React.JSX.Element {
  return (
    <button type="button" onClick={onClick} className="block w-full border-b border-bg-line/60 px-3 py-2 text-left last:border-b-0 hover:bg-bg-raised">
      <div className="font-mono text-[11px] text-ink">{children}</div>
      {sub && <div className="mt-0.5 text-[10px] leading-snug text-ink-faint">{sub}</div>}
    </button>
  );
}

function Sep(): React.JSX.Element {
  return <div className="mx-1 h-5 w-px bg-bg-line" />;
}

export function loadPreset(p: Preset): void {
  const sims = useSimStore.getState();
  sims.reset();
  useCircuitStore.getState().load(p.build());
  sims.setSpeed(p.speed);
  requestAnimationFrame(() => {
    fitView();
    useUiStore.getState().setScopeOpen(true);
    useSimStore.getState().play();
  });
}

export function Toolbar(): React.JSX.Element {
  const tool = useUiStore((s) => s.tool);
  const setTool = useUiStore((s) => s.setTool);
  const notify = useUiStore((s) => s.notify);
  const canUndo = useCircuitStore((s) => s.past.length > 0);
  const canRedo = useCircuitStore((s) => s.future.length > 0);
  const undo = useCircuitStore((s) => s.undo);
  const redo = useCircuitStore((s) => s.redo);
  const view = useViewportStore();
  const sim = useSimStore();
  const fileRef = useRef<HTMLInputElement>(null);

  const toolBtn = (t: Tool, icon: React.ReactNode, title: string): React.JSX.Element => (
    <Button size="icon" variant={tool === t ? "active" : "ghost"} onClick={() => setTool(t)} title={title} aria-pressed={tool === t}>
      {icon}
    </Button>
  );

  const onImport = async (file: File | undefined): Promise<void> => {
    if (!file) return;
    try {
      const data = await importJsonFile(file);
      sim.reset();
      useCircuitStore.getState().load(data);
      requestAnimationFrame(fitView);
      notify(`Imported “${data.name}” — ${data.components.length} parts.`);
    } catch (e) {
      notify(e instanceof CircuitFormatError ? e.message : "Could not read that file.", "error");
    }
  };

  const data = (): ReturnType<ReturnType<typeof useCircuitStore.getState>["toData"]> => useCircuitStore.getState().toData();

  return (
    <header className="flex h-11 shrink-0 items-center gap-1 border-b border-bg-line bg-bg-panel px-2">
      <div className="mr-2 flex items-center gap-2 pr-2">
        <div className="flex h-6 w-6 items-center justify-center border border-neon-green/70 bg-neon-green/10">
          <Zap className="h-3.5 w-3.5 text-neon-green" />
        </div>
        <div className="font-mono text-[12px] font-bold uppercase tracking-[0.2em] text-ink">
          Circuit<span className="text-neon-green">Lab</span>
        </div>
      </div>

      <Menu label="File" icon={<FileDown className="h-3.5 w-3.5" />}>
        {(close) => (
          <>
            <MenuItem
              onClick={() => {
                sim.reset();
                useCircuitStore.getState().load({ version: 1, name: "Untitled circuit", components: [], wires: [] });
                close();
              }}
            >
              <span className="flex items-center gap-2"><FilePlus2 className="h-3.5 w-3.5" /> New circuit</span>
            </MenuItem>
            <MenuItem onClick={() => { fileRef.current?.click(); close(); }}>
              <span className="flex items-center gap-2"><FileUp className="h-3.5 w-3.5" /> Import JSON…</span>
            </MenuItem>
            <MenuItem onClick={() => { exportJson(data()); close(); }} sub="Complete layout, parameters and wiring.">
              <span className="flex items-center gap-2"><FileDown className="h-3.5 w-3.5" /> Export JSON</span>
            </MenuItem>
            <MenuItem onClick={() => { void exportPng(data()); close(); }} sub="3× resolution, dark theme, includes live values.">
              <span className="flex items-center gap-2"><ImageIcon className="h-3.5 w-3.5" /> Export PNG</span>
            </MenuItem>
            <MenuItem onClick={() => { exportSvg(data()); close(); }} sub="Black-on-white vector schematic for printing.">
              <span className="flex items-center gap-2"><ImageIcon className="h-3.5 w-3.5" /> Export printable SVG</span>
            </MenuItem>
          </>
        )}
      </Menu>
      <input ref={fileRef} type="file" accept=".json,application/json" className="hidden" onChange={(e) => { void onImport(e.target.files?.[0]); e.target.value = ""; }} />

      <Menu label="Examples" icon={<Layers className="h-3.5 w-3.5" />}>
        {(close) => PRESETS.map((p) => (
          <MenuItem key={p.id} onClick={() => { loadPreset(p); close(); }} sub={p.description}>
            {p.name}
          </MenuItem>
        ))}
      </Menu>

      <Sep />
      {toolBtn("select", <MousePointer2 className="h-3.5 w-3.5" />, "Select (V)")}
      {toolBtn("wire", <Cable className="h-3.5 w-3.5" />, "Wire tool (W)")}
      {toolBtn("pan", <Hand className="h-3.5 w-3.5" />, "Pan (hold Space)")}
      <Sep />
      <Button size="icon" variant="ghost" disabled={!canUndo} onClick={undo} title="Undo (Ctrl+Z)"><Undo2 className="h-3.5 w-3.5" /></Button>
      <Button size="icon" variant="ghost" disabled={!canRedo} onClick={redo} title="Redo (Ctrl+Y)"><Redo2 className="h-3.5 w-3.5" /></Button>

      <Sep />
      <Button size="icon" variant={view.viewStyle === "physical" ? "active" : "ghost"} onClick={() => view.setViewStyle(view.viewStyle === "schematic" ? "physical" : "schematic")} title={`View: ${view.viewStyle} (click to switch)`}>
        <Layers className="h-3.5 w-3.5" />
      </Button>
      <span className="w-[72px] font-mono text-[10px] uppercase text-ink-faint">{view.viewStyle}</span>
      <Button size="icon" variant={view.gridMode !== "none" ? "active" : "ghost"} onClick={() => view.setGridMode(view.gridMode === "dots" ? "lines" : view.gridMode === "lines" ? "none" : "dots")} title={`Grid: ${view.gridMode} (G)`}>
        <Grid3x3 className="h-3.5 w-3.5" />
      </Button>
      <Button size="icon" variant={view.snapToGrid ? "active" : "ghost"} onClick={view.toggleSnap} title="Snap to grid"><Magnet className="h-3.5 w-3.5" /></Button>
      <Button size="icon" variant={view.showCurrent ? "active" : "ghost"} onClick={view.toggleCurrent} title="Animate current flow"><Activity className="h-3.5 w-3.5" /></Button>
      <Button size="icon" variant={view.showVoltages ? "active" : "ghost"} onClick={view.toggleVoltages} title="Hover readouts"><Eye className="h-3.5 w-3.5" /></Button>
      <Button size="icon" variant="ghost" onClick={fitView} title="Fit to circuit"><Maximize className="h-3.5 w-3.5" /></Button>

      <div className="flex-1" />

      <div className="flex items-center gap-1 border border-bg-line bg-bg px-1.5 py-0.5">
        <Button size="icon" variant={sim.running ? "active" : "primary"} onClick={sim.toggle} title={sim.running ? "Pause" : "Play"} aria-label={sim.running ? "Pause simulation" : "Run simulation"}>
          {sim.running ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        </Button>
        <Button size="icon" variant="ghost" onClick={sim.step} title="Single step"><SkipForward className="h-3.5 w-3.5" /></Button>
        <Button size="icon" variant="ghost" onClick={sim.reset} title="Reset (clears charge, latches, burnt parts)"><RotateCcw className="h-3.5 w-3.5" /></Button>
        <div className="mx-1 flex items-center gap-2">
          <span className="font-mono text-[10px] uppercase text-ink-faint">Speed</span>
          <input
            type="range"
            min={0}
            max={1}
            step={0.01}
            value={sliderFromSpeed(sim.speed)}
            onChange={(e) => sim.setSpeed(speedFromSlider(Number(e.target.value)))}
            className="h-1 w-28 accent-neon-green"
            aria-label="Simulation speed"
          />
          <span className="w-14 font-mono text-[11px] text-neon-green">{sim.speed >= 1 ? `${sim.speed.toFixed(sim.speed >= 10 ? 0 : 1)}×` : `1/${Math.round(1 / sim.speed)}×`}</span>
        </div>
      </div>
    </header>
  );
}
