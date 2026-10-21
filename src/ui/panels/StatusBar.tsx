"use client";

import { useEffect } from "react";
import { getLive, sim } from "@/engine/runtime";
import { formatTime } from "@/models/units";
import { useCircuitStore } from "@/store/circuitStore";
import { useSimStore } from "@/store/simulationStore";
import { useUiStore } from "@/store/uiStore";
import { useViewportStore } from "@/store/viewportStore";
import { cn } from "@/lib/utils";

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
      {burned > 0 && <span className="text-neon-red">{burned} burnt</span>}
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
    }, 4500);
    return () => clearTimeout(h);
  }, [toast]);
  if (!toast) return null;
  const tone =
    toast.tone === "error" ? "border-neon-red/70 text-neon-red" : toast.tone === "warn" ? "border-neon-amber/70 text-neon-amber" : "border-neon-cyan/70 text-neon-cyan";
  return (
    <div role="status" className={cn("pointer-events-none fixed bottom-12 left-1/2 z-50 -translate-x-1/2 border bg-bg-panel px-4 py-2 font-mono text-[12px] shadow-2xl", tone)}>
      {toast.text}
    </div>
  );
}
