import { buildNetlist } from "@/engine/netlist";
import { getLive } from "@/engine/runtime";
import { componentBBox } from "@/models/geometry";
import { GRID_PX, type CircuitData } from "@/models/types";
import { classifyWires, DARK_THEME, drawScene, PRINT_THEME, type Theme } from "@/ui/canvas/renderScene";
import { SvgContext } from "./svgContext";
import { parseCircuit, serializeCircuit } from "./serialize";

const G = GRID_PX;
const MARGIN = 2; // grid units

function contentBox(data: CircuitData): { x: number; y: number; w: number; h: number } {
  if (data.components.length === 0) return { x: 0, y: 0, w: 10 * G, h: 6 * G };
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const c of data.components) {
    const b = componentBBox(c);
    x0 = Math.min(x0, b.x0);
    y0 = Math.min(y0, b.y0);
    x1 = Math.max(x1, b.x1);
    y1 = Math.max(y1, b.y1 + 1);
  }
  return {
    x: (x0 - MARGIN) * G,
    y: (y0 - MARGIN) * G,
    w: Math.ceil((x1 - x0 + 2 * MARGIN) * G),
    h: Math.ceil((y1 - y0 + 2 * MARGIN) * G),
  };
}

function sceneFor(data: CircuitData, theme: Theme, live: boolean) {
  const nl = buildNetlist(data.components, data.wires);
  const netPins = new Map<string, string[]>();
  for (const [id, n] of nl.nets) netPins.set(id, n.pins);
  return {
    components: data.components,
    wires: data.wires,
    view: "schematic" as const,
    theme,
    snapshot: live ? getLive() : null,
    selectedComponents: new Set<string>(),
    selectedWires: new Set<string>(),
    showCurrent: false,
    wireClass: classifyWires(data.components, data.wires, nl.pinNet, netPins),
    hoverPin: null,
    now: 0,
    zoom: 1,
    animate: false,
  };
}

function download(name: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "circuit";

export function exportJson(data: CircuitData): void {
  download(`${slug(data.name)}.circuit.json`, new Blob([serializeCircuit(data)], { type: "application/json" }));
}

/** High-resolution PNG of the whole circuit (dark theme, includes live state if the simulation has run). */
export async function exportPng(data: CircuitData, scale = 3): Promise<void> {
  const box = contentBox(data);
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(box.w * scale);
  canvas.height = Math.ceil(box.h * scale);
  const ctx = canvas.getContext("2d")!;
  ctx.fillStyle = DARK_THEME.bg;
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, -box.x * scale, -box.y * scale);
  drawScene(ctx, sceneFor(data, DARK_THEME, true));
  const blob = await new Promise<Blob | null>((res) => canvas.toBlob(res, "image/png"));
  if (blob) download(`${slug(data.name)}.png`, blob);
}

/** Printable schematic: black on white, vector. */
export function exportSvg(data: CircuitData): void {
  const box = contentBox(data);
  const ctx = new SvgContext(box.w, box.h, PRINT_THEME.bg);
  ctx.translate(-box.x, -box.y);
  drawScene(ctx as unknown as CanvasRenderingContext2D, sceneFor(data, PRINT_THEME, false));
  download(`${slug(data.name)}.svg`, new Blob([ctx.toSvg(data.name)], { type: "image/svg+xml" }));
}

export async function importJsonFile(file: File): Promise<CircuitData> {
  return parseCircuit(await file.text());
}
