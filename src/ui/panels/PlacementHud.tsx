"use client";

import { FlipHorizontal2, RotateCcw, RotateCw, X } from "lucide-react";
import { getDef } from "@/models/catalog";
import { useUiStore } from "@/store/uiStore";
import { Button } from "../primitives/button";

/** Strip over the canvas while a part is armed: shows its orientation and the keys that change it. */
export function PlacementHud(): React.JSX.Element | null {
  const kind = useUiStore((s) => s.placingKind);
  const rot = useUiStore((s) => s.placeRotation);
  const mirror = useUiStore((s) => s.placeMirror);
  const rotate = useUiStore((s) => s.rotatePlacing);
  const flip = useUiStore((s) => s.flipPlacing);
  const cancel = useUiStore((s) => s.setPlacing);
  if (!kind) return null;
  return (
    <div className="pointer-events-auto absolute left-1/2 top-2 z-10 flex -translate-x-1/2 items-center gap-1.5 border border-neon-cyan/60 bg-bg-panel/95 px-2 py-1 font-mono text-[11px] shadow-xl">
      <span className="text-ink">
        Placing <span className="text-neon-cyan">{getDef(kind).name}</span>
      </span>
      <span className="text-ink-faint">·</span>
      <span data-testid="place-rotation" className="w-9 text-neon-green">{rot}°{mirror ? " ⇋" : ""}</span>
      <Button size="icon" variant="ghost" onClick={() => rotate(true)} title="Rotate counter-clockwise (Shift+R)" aria-label="Rotate counter-clockwise"><RotateCcw className="h-3.5 w-3.5" /></Button>
      <Button size="icon" variant="ghost" onClick={() => rotate(false)} title="Rotate clockwise (R)" aria-label="Rotate clockwise"><RotateCw className="h-3.5 w-3.5" /></Button>
      <Button size="icon" variant="ghost" onClick={flip} title="Mirror (F)" aria-label="Mirror"><FlipHorizontal2 className="h-3.5 w-3.5" /></Button>
      <span className="text-ink-faint"><span className="kbd">R</span> rotate · <span className="kbd">Esc</span> cancel</span>
      <Button size="icon" variant="ghost" onClick={() => cancel(null)} title="Stop placing (Esc)" aria-label="Stop placing"><X className="h-3.5 w-3.5" /></Button>
    </div>
  );
}
