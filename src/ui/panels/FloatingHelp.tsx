"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { getDef } from "@/models/catalog";
import { useUiStore } from "@/store/uiStore";
import { HelpCard } from "./HelpCard";

/**
 * Hover help for a part: a card that follows the pointer dwell position. `x`/`y` are viewport coordinates
 * (px) of the anchor; the card flips to stay on screen.
 */
export function HelpPopover({ kind, x, y, side = "right" }: { kind: string; x: number; y: number; side?: "right" | "below" }): React.JSX.Element {
  const ref = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: x, top: y });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    let left = side === "right" ? x + 12 : x - w / 2;
    let top = side === "right" ? y - 12 : y + 18;
    if (left + w > vw - 8) left = Math.max(8, (side === "right" ? x - w - 12 : vw - w - 8));
    if (left < 8) left = 8;
    if (top + h > vh - 8) top = Math.max(8, vh - h - 8);
    if (top < 8) top = 8;
    setPos({ left, top });
  }, [kind, x, y, side]);
  const def = getDef(kind);
  return (
    <div
      ref={ref}
      role="tooltip"
      style={{ left: pos.left, top: pos.top }}
      className="pointer-events-none fixed z-50 w-[320px] max-w-[calc(100vw-16px)] border border-neon-cyan/60 bg-bg-panel p-3 shadow-2xl"
    >
      <div className="mb-1.5 flex items-baseline justify-between gap-2">
        <span className="font-mono text-[12px] text-ink">{def.name}</span>
        <span className="font-mono text-[9px] uppercase text-ink-faint">{def.category}</span>
      </div>
      <HelpCard kind={kind} compact />
    </div>
  );
}

/** Dwell help over a part on the canvas (position set by the canvas after the pointer rests on a part). */
export function CanvasHelp(): React.JSX.Element | null {
  const h = useUiStore((s) => s.helpHover);
  if (!h) return null;
  return <HelpPopover kind={h.kind} x={h.x} y={h.y} />;
}
