import { CATALOG } from "@/models/catalog";
import type { CircuitData, PlacedComponent, Rotation, Wire } from "@/models/types";

export class CircuitFormatError extends Error {}

const ROTATIONS: Rotation[] = [0, 90, 180, 270];

export function serializeCircuit(data: CircuitData): string {
  return JSON.stringify(data, null, 2);
}

/** Parse + validate untrusted JSON. Unknown part kinds and dangling wires are rejected. */
export function parseCircuit(text: string): CircuitData {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new CircuitFormatError("File is not valid JSON.");
  }
  if (typeof raw !== "object" || raw === null) throw new CircuitFormatError("Unexpected file contents.");
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) throw new CircuitFormatError("Unsupported circuit file version.");
  if (!Array.isArray(obj.components) || !Array.isArray(obj.wires)) {
    throw new CircuitFormatError("Missing components or wires.");
  }

  const components: PlacedComponent[] = [];
  for (const item of obj.components as unknown[]) {
    const c = item as Partial<PlacedComponent>;
    if (typeof c.id !== "string" || typeof c.kind !== "string") throw new CircuitFormatError("Malformed component.");
    const def = CATALOG.get(c.kind);
    if (!def) throw new CircuitFormatError(`Unknown component type "${c.kind}".`);
    components.push({
      id: c.id,
      kind: c.kind,
      x: Number(c.x) || 0,
      y: Number(c.y) || 0,
      rotation: ROTATIONS.includes(c.rotation as Rotation) ? (c.rotation as Rotation) : 0,
      mirror: Boolean(c.mirror),
      params: { ...def.defaults, ...(typeof c.params === "object" && c.params ? c.params : {}) },
      label: typeof c.label === "string" ? c.label : def.prefix,
    });
  }

  const byId = new Map(components.map((c) => [c.id, c]));
  const wires: Wire[] = [];
  for (const item of obj.wires as unknown[]) {
    const w = item as Partial<Wire>;
    const fc = w.from && byId.get(w.from.componentId);
    const tc = w.to && byId.get(w.to.componentId);
    if (typeof w.id !== "string" || !w.from || !w.to || !fc || !tc) continue;
    const hasPins =
      CATALOG.get(fc.kind)!.pins.some((p) => p.id === w.from!.pinId) &&
      CATALOG.get(tc.kind)!.pins.some((p) => p.id === w.to!.pinId);
    if (!hasPins) continue;
    wires.push({
      id: w.id,
      from: { componentId: w.from.componentId, pinId: w.from.pinId },
      to: { componentId: w.to.componentId, pinId: w.to.pinId },
      color: w.color ?? "auto",
      custom: w.custom,
      routing: w.routing === "bezier" ? "bezier" : "orthogonal",
    });
  }

  return {
    version: 1,
    name: typeof obj.name === "string" ? obj.name : "Imported circuit",
    components,
    wires,
  };
}
