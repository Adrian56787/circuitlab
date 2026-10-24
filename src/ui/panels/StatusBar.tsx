"use client";

import { useEffect } from "react";
import { AlertTriangle, Wrench, X } from "lucide-react";
import { burnTimes, getLive, sim } from "@/engine/runtime";
import { formatTime } from "@/models/units";
import { useCircuitStore } from "@/store/circuitStore";
import { useSimStore } from "@/store/simulationStore";
import { useUiStore } from "@/store/uiStore";
import { useViewportStore } from "@/store/viewportStore";
import { cn } from "@/lib/utils";

/** Failure log: every destroyed part with the reason it failed. */
export function FailureLog(): React.JSX.Element | null {
  const open = useUiStore((s) => s.failuresOpen);
  const setOpen = useUiStore((s) => s.setFailuresOpen);
  const bump = useSimStore((s) => s.bump);
  useSimStore((s) => s.tick);
  const failures = getLive()?.failures ?? [];
  useEffect(() => {
    if (open && failures.length === 0) setOpen(false);
  }, [open, failures.length, setOpen]);
  if (!open || failures.length === 0) return null;

  const repair = (id: string): void => {
    sim.repair(id);
    burnTimes.delete(id);
    bump();
  };
  return (
    <div role="dialog" aria-label="Failure log" className="fixed bottom-8 right-3 z-50 flex max-h-[60vh] w-[460px] max-w-[calc(100vw-24px)] flex-col border border-neon-red/60 bg-bg-panel shadow-2xl">
      <div className="flex items-center gap-2 border-b border-neon-red/40 px-3 py-2">
        <AlertTriangle className="h-3.5 w-3.5 text-neon-red" />
        <span className="flex-1 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-neon-red">Failure log · {failures.length}</span>
        <button
          type="button"
          onClick={() => failures.forEach((f) => repair(f.id))}
          className="font-mono text-[10px] uppercase tracking-wider text-ink-dim hover:text-neon-cyan"
        >
          Replace all
        </button>
        <button type="button" onClick={() => setOpen(false)} aria-label="Close failure log" className="text-ink-faint hover:text-ink">
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
      <ul className="scroll-thin min-h-0 flex-1 divide-y divide-bg-line overflow-y-auto">
        {failures.map((f) => (
          <li key={f.id} className="space-y-1 px-3 py-2">
            <div className="flex items-baseline gap-2 font-mono text-[11px]">
              <button
                type="button"
                className="text-neon-red underline-offset-2 hover:underline"
                onClick={() => {
                  useCircuitStore.getState().select({ components: [f.id] });
                  useUiStore.getState().setInspectorOpen(true);
                }}
                title="Select this part"
              >
                {f.label}
              </button>
              <span className="text-ink-dim">{f.name}</span>
              <span className="ml-auto text-ink-faint">t = {formatTime(f.time)}</span>
            </div>
            <p className="text-[11px] leading-snug text-ink">{f.reason}</p>
            <button type="button" onClick={() => repair(f.id)} className="inline-flex items-center gap-1 font-mono text-[10px] uppercase tracking-wider text-ink-dim hover:text-neon-green">
              <Wrench className="h-3 w-3" /> Replace part
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function StatusBar(): React.JSX.Element {
  const running = useSimStore((s) => s.running);
  useSimStore((s) => s.tick);
  const comps = useCircuitStore((s) => s.components.length);
  const wires = useCircuitStore((s) => s.wires.length);
  const zoom = useViewportStore((s) => s.zoom);
  const live = getLive();
  const diag = live?.diagnostics;
  const burned = live?.burned.length ?? 0;
  const t = sim.time;

  let status: { text: string; cls: string };
  if (diag?.singular) status = { text: "ERROR", cls: "bg-neon-red/20 text-neon-red border-neon-red/60" };
  else if (running) status = { text: "RUNNING", cls: "bg-neon-green/15 text-neon-green border-neon-green/60" };
  else if (t > 0) status = { text: "PAUSED", cls: "bg-neon-amber/15 text-neon-amber border-neon-amber/60" };
  else status = { text: "IDLE", cls: "bg-bg-raised text-ink-dim border-bg-line" };

  const message = diag?.messages[diag.messages.length - 1];

  return (
    <footer className="flex h-7 shrink-0 items-center gap-3 border-t border-bg-line bg-bg-panel px-3 font-mono text-[10px] uppercase tracking-wider text-ink-dim">
      <span className={cn("border px-1.5 py-px", status.cls)}>{status.text}</span>
      <span>T <span className="text-ink">{formatTime(t)}</span></span>
      {diag && (
        <span className={diag.converged ? "" : "text-neon-red"}>
          NR <span className="text-ink">{diag.iterations}</span> it{diag.converged ? "" : " · no convergence"}
        </span>
      )}
      {burned > 0 && (
        <button
          type="button"
          onClick={() => useUiStore.getState().setFailuresOpen(!useUiStore.getState().failuresOpen)}
          className="flex items-center gap-1 border border-neon-red/60 bg-neon-red/10 px-1.5 py-px text-neon-red hover:bg-neon-red/20"
          title="Why did parts fail? Click for the failure log"
          aria-label={`${burned} burnt parts, open the failure log`}
        >
          <AlertTriangle className="h-3 w-3" /> {burned} burnt · why?
        </button>
      )}
      <span className="min-w-0 flex-1 truncate normal-case tracking-normal text-neon-amber">{message}</span>
      <span>{comps} parts · {wires} wires</span>
      <span>Zoom <span className="text-ink">{Math.round(zoom * 100)}%</span></span>
    </footer>
  );
}

export function Toasts(): React.JSX.Element | null {
  const toast = useUiStore((s) => s.toast);
  useEffect(() => {
    if (!toast) return;
    const id = toast.id;
    const h = setTimeout(() => {
      if (useUiStore.getState().toast?.id === id) useUiStore.setState({ toast: null });
    }, toast.ms);
    return () => clearTimeout(h);
  }, [toast]);
  if (!toast) return null;
  const tone =
    toast.tone === "error" ? "border-neon-red/70 text-neon-red" : toast.tone === "warn" ? "border-neon-amber/70 text-neon-amber" : "border-neon-cyan/70 text-neon-cyan";
  return (
    <div role="status" className={cn("pointer-events-none fixed bottom-12 left-1/2 z-50 max-w-[min(680px,calc(100vw-32px))] -translate-x-1/2 border bg-bg-panel px-4 py-2 font-mono text-[12px] leading-snug shadow-2xl", tone)}>
      {toast.text}
    </div>
  );
}
