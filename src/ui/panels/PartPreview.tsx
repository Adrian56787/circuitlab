"use client";

import { memo, useEffect, useRef } from "react";
import { GRID_PX, type ComponentDef, type PlacedComponent } from "@/models/types";
import { drawComponent } from "../canvas/symbols";

interface Props {
  def: ComponentDef;
  view: "schematic" | "physical";
  width?: number;
  height?: number;
}

/** Small static thumbnail of a catalog part in either representation. */
function PartPreviewBase({ def, view, width = 64, height = 40 }: Props): React.JSX.Element {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = width * dpr;
    canvas.height = height * dpr;
    const ctx = canvas.getContext("2d")!;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);

    const [x0, y0, x1, y1] = def.bounds;
    const bw = x1 - x0 + 1;
    const bh = y1 - y0 + 1;
    const unit = Math.min(width / bw, height / bh, GRID_PX);
    const comp: PlacedComponent = {
      id: "preview",
      kind: def.kind,
      x: 0,
      y: 0,
      rotation: 0,
      mirror: false,
      params: { ...def.defaults },
      label: def.prefix,
    };
    ctx.translate(width / 2 - ((x0 + x1) / 2) * unit, height / 2 - ((y0 + y1) / 2) * unit);
    ctx.scale(unit, unit);
    drawComponent(ctx, comp, def, {
      view,
      stroke: view === "schematic" ? "#d7dde5" : "#d7dde5",
      dim: "#8a94a3",
      accent: "#2fd8ff",
      rotation: 0,
      mirror: false,
      burned: false,
      now: 0,
    });
  }, [def, view, width, height]);

  return <canvas ref={ref} style={{ width, height }} className="shrink-0 bg-bg" aria-hidden />;
}

export const PartPreview = memo(PartPreviewBase);
