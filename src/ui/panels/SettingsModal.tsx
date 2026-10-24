"use client";

import { Eye, Layers, RotateCcw, Settings, X } from "lucide-react";
import { useEffect, useMemo, useRef } from "react";
import { CATALOG_LIST } from "@/models/catalog";
import { FEATURE_GROUPS, LOCKED_GROUPS, groupOf } from "@/models/featureGroups";
import { cn } from "@/lib/utils";
import { useSettingsStore, type ViewMode } from "@/store/settingsStore";
import { useUiStore } from "@/store/uiStore";
import { Button } from "../primitives/button";

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (v: boolean) => void; label: string; disabled?: boolean }): React.JSX.Element {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative h-5 w-9 shrink-0 border transition-colors disabled:cursor-not-allowed disabled:opacity-40",
        checked ? "border-neon-green/70 bg-neon-green/20" : "border-bg-line bg-bg",
      )}
    >
      <span className={cn("absolute top-0.5 h-3.5 w-3.5 transition-all", checked ? "left-[18px] bg-neon-green" : "left-0.5 bg-ink-faint")} />
    </button>
  );
}

function Section({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="border-b border-bg-line px-4 py-3 last:border-b-0">
      <div className="panel-title mb-2 flex items-center gap-1.5 !text-ink">
        {icon}
        {title}
      </div>
      {children}
    </section>
  );
}

export function SettingsModal(): React.JSX.Element | null {
  const open = useUiStore((s) => s.settingsOpen);
  const setOpen = useUiStore((s) => s.setSettingsOpen);
  const disabled = useSettingsStore((s) => s.disabledGroups);
  const viewMode = useSettingsStore((s) => s.viewMode);
  const hoverHelp = useSettingsStore((s) => s.hoverHelp);
  const setGroup = useSettingsStore((s) => s.setGroupEnabled);
  const setAll = useSettingsStore((s) => s.setAllGroups);
  const setViewMode = useSettingsStore((s) => s.setViewMode);
  const setHoverHelp = useSettingsStore((s) => s.setHoverHelp);
  const reset = useSettingsStore((s) => s.reset);
  const closeRef = useRef<HTMLButtonElement>(null);

  const counts = useMemo(() => {
    const m = new Map<string, number>();
    for (const d of CATALOG_LIST) m.set(groupOf(d), (m.get(groupOf(d)) ?? 0) + 1);
    return m;
  }, []);

  useEffect(() => {
    if (!open) return;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === "Escape") {
        e.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, setOpen]);

  if (!open) return null;

  const modes: { id: ViewMode; label: string; sub: string }[] = [
    { id: "simple", label: "Simple view", sub: "Everyday values only (resistance, capacitance, voltage…). Hides model coefficients." },
    { id: "advanced", label: "Advanced view", sub: "Every parameter, including SPICE-style model coefficients, ratings and coupling." },
  ];
  const enabledCount = FEATURE_GROUPS.filter((g) => !disabled[g.id]).length;

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" onMouseDown={(e) => e.target === e.currentTarget && setOpen(false)}>
      <div role="dialog" aria-modal="true" aria-label="Settings" className="flex max-h-[min(720px,calc(100vh-32px))] w-full max-w-[560px] flex-col border border-bg-line bg-bg-panel shadow-2xl">
        <div className="flex items-center gap-2 border-b border-bg-line px-4 py-2.5">
          <Settings className="h-4 w-4 text-neon-cyan" />
          <h2 className="flex-1 font-mono text-[12px] font-bold uppercase tracking-[0.18em] text-ink">Settings</h2>
          <button ref={closeRef} type="button" onClick={() => setOpen(false)} aria-label="Close settings" className="text-ink-faint hover:text-ink">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="scroll-thin min-h-0 flex-1 overflow-y-auto">
          <Section icon={<Eye className="h-3.5 w-3.5" />} title="Inspector view">
            <div role="radiogroup" aria-label="Inspector view mode" className="grid grid-cols-2 gap-2">
              {modes.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  role="radio"
                  aria-checked={viewMode === m.id}
                  onClick={() => setViewMode(m.id)}
                  className={cn("border p-2 text-left transition-colors", viewMode === m.id ? "border-neon-cyan bg-neon-cyan/10" : "border-bg-line hover:border-ink-faint")}
                >
                  <div className={cn("font-mono text-[11px]", viewMode === m.id ? "text-neon-cyan" : "text-ink")}>{m.label}</div>
                  <div className="mt-0.5 text-[10px] leading-snug text-ink-faint">{m.sub}</div>
                </button>
              ))}
            </div>
            <div className="mt-3 flex items-center gap-3">
              <Switch checked={hoverHelp} onChange={setHoverHelp} label="Show part help on hover" />
              <div>
                <div className="font-mono text-[11px] text-ink">Hover help</div>
                <div className="text-[10px] text-ink-faint">Explain a part (what it does, formulas, uses) when the pointer rests on it.</div>
              </div>
            </div>
          </Section>

          <Section icon={<Layers className="h-3.5 w-3.5" />} title="Component library">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-[10px] text-ink-faint">
                {enabledCount} of {FEATURE_GROUPS.length} categories shown. Parts already on the canvas are never removed.
              </span>
              <span className="flex gap-1">
                <Button size="sm" onClick={() => setAll(true)}>All on</Button>
                <Button size="sm" onClick={() => setAll(false, [...LOCKED_GROUPS])}>All off</Button>
              </span>
            </div>
            <ul className="space-y-px border border-bg-line bg-bg-line">
              {FEATURE_GROUPS.map((g) => {
                const locked = LOCKED_GROUPS.has(g.id);
                const on = !disabled[g.id];
                return (
                  <li key={g.id} className="flex items-center gap-3 bg-bg-panel px-2.5 py-1.5">
                    <Switch checked={on} disabled={locked} onChange={(v) => setGroup(g.id, v)} label={`Show ${g.label}`} />
                    <div className="min-w-0 flex-1">
                      <div className={cn("font-mono text-[11px]", on ? "text-ink" : "text-ink-faint")}>{g.label}</div>
                      <div className="truncate text-[10px] text-ink-faint">{g.description}</div>
                    </div>
                    <span className="font-mono text-[10px] text-ink-faint">{counts.get(g.id) ?? 0}</span>
                  </li>
                );
              })}
            </ul>
          </Section>
        </div>

        <div className="flex items-center justify-between border-t border-bg-line px-4 py-2.5">
          <Button size="sm" onClick={reset}>
            <RotateCcw className="h-3.5 w-3.5" /> Restore defaults
          </Button>
          <Button size="sm" variant="primary" onClick={() => setOpen(false)}>
            Done
          </Button>
        </div>
      </div>
    </div>
  );
}
