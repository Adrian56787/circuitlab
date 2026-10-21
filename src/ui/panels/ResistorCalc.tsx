"use client";

import { X } from "lucide-react";
import { useMemo, useState } from "react";
import { BAND_COLORS, bandsToResistance, resistanceToBands, type ColorBand } from "@/models/resistorColor";
import { formatEng, parseEng } from "@/models/units";
import { useCircuitStore } from "@/store/circuitStore";
import { useUiStore } from "@/store/uiStore";
import { cn } from "@/lib/utils";
import { Button } from "../primitives/button";
import { Input } from "../primitives/input";

const DIGIT = BAND_COLORS.filter((c) => c.digit !== undefined);
const MULT = BAND_COLORS.filter((c) => c.multiplier !== undefined);
const TOL = BAND_COLORS.filter((c) => c.tolerance !== undefined);

export function ResistorBody({ bands, className }: { bands: ColorBand[]; className?: string }): React.JSX.Element {
  const n = bands.length;
  const xs = n === 5 ? [58, 76, 94, 120, 150] : [62, 82, 102, 146];
  return (
    <svg viewBox="0 0 220 60" className={className} role="img" aria-label="Resistor with colour bands">
      <line x1="0" y1="30" x2="220" y2="30" stroke="#aab2bd" strokeWidth="4" strokeLinecap="round" />
      <rect x="40" y="10" width="140" height="40" rx="16" fill="#d8c7a0" />
      <rect x="40" y="10" width="140" height="20" rx="14" fill="rgba(255,255,255,0.22)" />
      {bands.map((b, i) => (
        <rect key={i} x={xs[i]} y="10" width="11" height="40" fill={b.hex} stroke="rgba(0,0,0,0.35)" strokeWidth="0.5" />
      ))}
    </svg>
  );
}

function BandPicker({
  label,
  options,
  value,
  onChange,
  show,
}: {
  label: string;
  options: ColorBand[];
  value: string;
  onChange: (name: string) => void;
  show: (b: ColorBand) => string;
}): React.JSX.Element {
  return (
    <div>
      <div className="panel-title mb-1">{label}</div>
      <div className="flex flex-wrap gap-1">
        {options.map((b) => (
          <button
            key={b.name}
            type="button"
            title={`${b.name} · ${show(b)}`}
            onClick={() => onChange(b.name)}
            className={cn(
              "flex h-8 w-9 flex-col items-center justify-end border pb-0.5 font-mono text-[9px] leading-none",
              value === b.name ? "border-neon-cyan" : "border-bg-line hover:border-ink-faint",
            )}
            style={{ background: b.hex, color: ["#111111", "#7a4a21", "#2b66d9", "#8a3fd1", "#d62d2d", "#2f9e44"].includes(b.hex) ? "#fff" : "#111" }}
          >
            {show(b)}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ResistorCalc(): React.JSX.Element | null {
  const open = useUiStore((s) => s.colorCalcOpen);
  const setOpen = useUiStore((s) => s.setColorCalcOpen);
  const selection = useCircuitStore((s) => s.selection);
  const comps = useCircuitStore((s) => s.components);
  const update = useCircuitStore((s) => s.updateParams);

  const [five, setFive] = useState(false);
  const [names, setNames] = useState<string[]>(["Brown", "Black", "Red", "Gold"]);
  const [text, setText] = useState("");

  const selected = comps.find((c) => selection.components.length === 1 && c.id === selection.components[0] && c.kind === "resistor");

  const nDigits = five ? 3 : 2;
  const current = useMemo(() => {
    const n = [...names];
    while (n.length < nDigits + 2) n.splice(nDigits, 0, "Black");
    return n.slice(0, nDigits + 2);
  }, [names, nDigits]);
  const result = bandsToResistance(current);
  const bands = current.map((n) => BAND_COLORS.find((c) => c.name === n)!);

  if (!open) return null;

  const setBand = (i: number, name: string): void => {
    const next = [...current];
    next[i] = name;
    setNames(next);
  };

  const fromValue = (): void => {
    const v = parseEng(text);
    if (!(v > 0)) return;
    const r = resistanceToBands(v, 5, five);
    setNames(r.bands.map((b) => b.name));
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onMouseDown={() => setOpen(false)}>
      <div
        className="w-full max-w-[520px] border border-bg-line bg-bg-panel shadow-2xl"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-label="Resistor colour code calculator"
      >
        <div className="flex items-center justify-between border-b border-bg-line px-3 py-2">
          <span className="panel-title !text-ink">Resistor colour-code calculator</span>
          <button type="button" onClick={() => setOpen(false)} className="text-ink-dim hover:text-ink" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>
        <div className="space-y-3 p-3">
          <ResistorBody bands={bands} className="h-16 w-full bg-bg p-2" />
          <div className="flex items-end justify-between gap-3">
            <div>
              <div className="font-mono text-2xl text-neon-cyan">{formatEng(result.ohms, "ohm", 4)}</div>
              <div className="font-mono text-[11px] text-ink-dim">±{result.tolerance}% · {five ? "5" : "4"}-band</div>
            </div>
            <div className="flex gap-1">
              <Button variant={!five ? "active" : "default"} size="sm" onClick={() => setFive(false)}>4 band</Button>
              <Button variant={five ? "active" : "default"} size="sm" onClick={() => setFive(true)}>5 band</Button>
            </div>
          </div>

          <div className="grid gap-2">
            {Array.from({ length: nDigits }, (_, i) => (
              <BandPicker key={i} label={`Digit ${i + 1}`} options={DIGIT} value={current[i]!} onChange={(n) => setBand(i, n)} show={(b) => String(b.digit)} />
            ))}
            <BandPicker label="Multiplier" options={MULT} value={current[nDigits]!} onChange={(n) => setBand(nDigits, n)} show={(b) => `×${formatEng(b.multiplier!, "none", 2).replace(" ", "")}`} />
            <BandPicker label="Tolerance" options={TOL} value={current[nDigits + 1]!} onChange={(n) => setBand(nDigits + 1, n)} show={(b) => `${b.tolerance}%`} />
          </div>

          <div className="flex items-center gap-2 border-t border-bg-line pt-3">
            <Input value={text} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && fromValue()} placeholder="Value → bands, e.g. 4.7k" className="flex-1" />
            <Button onClick={fromValue}>Show bands</Button>
            <Button
              variant="primary"
              disabled={!selected}
              title={selected ? `Apply to ${selected.label}` : "Select a resistor on the canvas first"}
              onClick={() => selected && update(selected.id, { resistance: result.ohms, tolerance: String(result.tolerance) })}
            >
              Apply{selected ? ` to ${selected.label}` : ""}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
