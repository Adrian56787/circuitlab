"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { useRef } from "react";
import { cn } from "@/lib/utils";
import { useCircuitStore } from "@/store/circuitStore";
import { useUiStore } from "@/store/uiStore";
import { getDef } from "@/models/catalog";
import { CodeEditor } from "./CodeEditor";
import { SerialMonitor } from "./SerialMonitor";
import { InstrumentsView } from "./ScopePanel";

type Tab = "instruments" | "code" | "serial";

/** Bottom dock: instruments, sketch editor and serial monitor. */
export function Dock(): React.JSX.Element | null {
  const open = useUiStore((s) => s.scopeOpen);
  const setOpen = useUiStore((s) => s.setScopeOpen);
  const tab = useUiStore((s) => s.dockTab);
  const setTab = useUiStore((s) => s.setDockTab);
  const height = useUiStore((s) => s.dockHeight);
  const setHeight = useUiStore((s) => s.setDockHeight);
  const comps = useCircuitStore((s) => s.components);
  const drag = useRef<{ y: number; h: number } | null>(null);

  const hasInstr = comps.some((c) => c.kind === "scope" || c.kind === "logic_analyzer");
  const hasMcu = comps.some((c) => getDef(c.kind)?.sim === "mcu");
  if (!hasInstr && !hasMcu) return null;

  const tabs: { id: Tab; label: string; show: boolean }[] = [
    { id: "instruments", label: "Instruments", show: hasInstr },
    { id: "code", label: "Code", show: hasMcu },
    { id: "serial", label: "Serial monitor", show: hasMcu },
  ];
  const visible = tabs.filter((t) => t.show);
  const active: Tab = visible.some((t) => t.id === tab) ? tab : (visible[0]?.id ?? "instruments");

  return (
    <div className="border-t border-bg-line bg-bg-panel">
      {open && (
        <div
          className="h-1 cursor-row-resize hover:bg-neon-cyan/40"
          onPointerDown={(e) => {
            drag.current = { y: e.clientY, h: height };
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
          }}
          onPointerMove={(e) => {
            if (drag.current) setHeight(drag.current.h + (drag.current.y - e.clientY));
          }}
          onPointerUp={() => (drag.current = null)}
        />
      )}
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen(!open)}
          className="flex items-center gap-1 px-3 py-1.5 hover:bg-bg-raised"
          aria-label={open ? "Collapse panel" : "Expand panel"}
        >
          {open ? <ChevronDown className="h-3.5 w-3.5 text-ink-dim" /> : <ChevronUp className="h-3.5 w-3.5 text-ink-dim" />}
        </button>
        {visible.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => {
              setTab(t.id);
              setOpen(true);
            }}
            className={cn(
              "px-3 py-1.5 font-mono text-[11px] uppercase tracking-wider",
              active === t.id && open ? "border-b-2 border-neon-cyan text-ink" : "text-ink-dim hover:text-ink",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>
      {open && (
        <div className="border-t border-bg-line" style={{ height }}>
          {active === "instruments" && <InstrumentsView />}
          {active === "code" && <CodeEditor />}
          {active === "serial" && <SerialMonitor />}
        </div>
      )}
    </div>
  );
}
