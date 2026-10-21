import { getDef, pinDef } from "./catalog";
import type { PinRef, PlacedComponent, Rotation, Vec2, Wire, WireRouting } from "./types";

export const snap = (v: number, step = 1): number => Math.round(v / step) * step;

/** Rotate a local vector clockwise (screen coordinates, y down). */
export function rotateVec(v: Vec2, rot: Rotation): Vec2 {
  switch (rot) {
    case 90:
      return { x: -v.y, y: v.x };
    case 180:
      return { x: -v.x, y: -v.y };
    case 270:
      return { x: v.y, y: -v.x };
    default:
      return { x: v.x, y: v.y };
  }
}

export function localToWorld(c: PlacedComponent, p: Vec2): Vec2 {
  const m = c.mirror ? { x: -p.x, y: p.y } : p;
  const r = rotateVec(m, c.rotation);
  return { x: r.x + c.x, y: r.y + c.y };
}

export function worldToLocal(c: PlacedComponent, p: Vec2): Vec2 {
  const t = { x: p.x - c.x, y: p.y - c.y };
  const inv = ((360 - c.rotation) % 360) as Rotation;
  const r = rotateVec(t, inv);
  return c.mirror ? { x: -r.x, y: r.y } : r;
}

export function pinWorld(c: PlacedComponent, pinId: string): Vec2 {
  const p = pinDef(c.kind, pinId);
  if (!p) return { x: c.x, y: c.y };
  return localToWorld(c, p);
}

/** Axis-aligned world bounding box (grid units) of a placed component. */
export function componentBBox(c: PlacedComponent): { x0: number; y0: number; x1: number; y1: number } {
  const [bx0, by0, bx1, by1] = getDef(c.kind).bounds;
  const pts = [
    localToWorld(c, { x: bx0, y: by0 }),
    localToWorld(c, { x: bx1, y: by0 }),
    localToWorld(c, { x: bx1, y: by1 }),
    localToWorld(c, { x: bx0, y: by1 }),
  ];
  return {
    x0: Math.min(...pts.map((p) => p.x)),
    y0: Math.min(...pts.map((p) => p.y)),
    x1: Math.max(...pts.map((p) => p.x)),
    y1: Math.max(...pts.map((p) => p.y)),
  };
}

export function hitComponent(c: PlacedComponent, p: Vec2, pad = 0.25): boolean {
  const l = worldToLocal(c, p);
  const [x0, y0, x1, y1] = getDef(c.kind).bounds;
  return l.x >= x0 - pad && l.x <= x1 + pad && l.y >= y0 - pad && l.y <= y1 + pad;
}

/** Unit vector (world) pointing out of the part at a pin. */
export function pinOutward(c: PlacedComponent, pinId: string): Vec2 {
  const def = getDef(c.kind);
  const p = def.pins.find((q) => q.id === pinId);
  if (!p) return { x: 1, y: 0 };
  const [x0, y0, x1, y1] = def.bounds;
  const dl = Math.abs(p.x - x0);
  const dr = Math.abs(x1 - p.x);
  const dt = Math.abs(p.y - y0);
  const db = Math.abs(y1 - p.y);
  const m = Math.min(dl, dr, dt, db);
  let v: Vec2;
  if (m === dl) v = { x: -1, y: 0 };
  else if (m === dr) v = { x: 1, y: 0 };
  else if (m === dt) v = { x: 0, y: -1 };
  else v = { x: 0, y: 1 };
  if (c.mirror) v = { x: -v.x, y: v.y };
  return rotateVec(v, c.rotation);
}

// ───────────────────────── Wire routing ─────────────────────────

const add = (a: Vec2, b: Vec2, k = 1): Vec2 => ({ x: a.x + b.x * k, y: a.y + b.y * k });
const same = (a: Vec2, b: Vec2): boolean => Math.abs(a.x - b.x) < 1e-6 && Math.abs(a.y - b.y) < 1e-6;

function simplify(pts: Vec2[]): Vec2[] {
  const out: Vec2[] = [];
  for (const p of pts) {
    const last = out[out.length - 1];
    if (last && same(last, p)) continue;
    out.push(p);
  }
  // remove collinear middle points
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 1; i < out.length - 1; i++) {
      const a = out[i - 1]!;
      const b = out[i]!;
      const c = out[i + 1]!;
      const cross = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
      if (Math.abs(cross) < 1e-9) {
        out.splice(i, 1);
        changed = true;
        break;
      }
    }
  }
  return out;
}

export function orthogonalRoute(a: Vec2, da: Vec2, b: Vec2, db: Vec2): Vec2[] {
  const p1 = add(a, da);
  const p2 = add(b, db);
  let mid: Vec2[];
  if (Math.abs(p1.x - p2.x) < 1e-9 || Math.abs(p1.y - p2.y) < 1e-9) {
    mid = [p1, p2];
  } else if (da.x !== 0 && db.x !== 0) {
    // horizontal–vertical–horizontal
    const xm = snap((p1.x + p2.x) / 2, 0.5);
    mid = [p1, { x: xm, y: p1.y }, { x: xm, y: p2.y }, p2];
  } else if (da.y !== 0 && db.y !== 0) {
    const ym = snap((p1.y + p2.y) / 2, 0.5);
    mid = [p1, { x: p1.x, y: ym }, { x: p2.x, y: ym }, p2];
  } else if (da.x !== 0) {
    mid = [p1, { x: p2.x, y: p1.y }, p2];
  } else {
    mid = [p1, { x: p1.x, y: p2.y }, p2];
  }
  return simplify([a, ...mid, b]);
}

export function bezierRoute(a: Vec2, da: Vec2, b: Vec2, db: Vec2, samples = 28): Vec2[] {
  const d = Math.max(2, Math.hypot(b.x - a.x, b.y - a.y) / 2);
  const c1 = add(a, da, d);
  const c2 = add(b, db, d);
  const pts: Vec2[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const u = 1 - t;
    pts.push({
      x: u * u * u * a.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * b.x,
      y: u * u * u * a.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * b.y,
    });
  }
  return pts;
}

export function routeBetween(
  a: Vec2,
  da: Vec2,
  b: Vec2,
  db: Vec2,
  routing: WireRouting,
): Vec2[] {
  return routing === "bezier" ? bezierRoute(a, da, b, db) : orthogonalRoute(a, da, b, db);
}

export function wirePolyline(w: Wire, byId: ReadonlyMap<string, PlacedComponent>): Vec2[] | null {
  const ca = byId.get(w.from.componentId);
  const cb = byId.get(w.to.componentId);
  if (!ca || !cb) return null;
  return routeBetween(
    pinWorld(ca, w.from.pinId),
    pinOutward(ca, w.from.pinId),
    pinWorld(cb, w.to.pinId),
    pinOutward(cb, w.to.pinId),
    w.routing,
  );
}

export function distToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

export function distToPolyline(p: Vec2, pts: Vec2[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length - 1; i++) {
    best = Math.min(best, distToSegment(p, pts[i]!, pts[i + 1]!));
  }
  return best;
}

export function polylineLength(pts: Vec2[]): number {
  let len = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    len += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
  }
  return len;
}

/** Point at distance `d` along the polyline. */
export function pointAlong(pts: Vec2[], d: number): Vec2 {
  let rem = d;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (rem <= seg || i === pts.length - 2) {
      const t = seg === 0 ? 0 : Math.min(1, rem / seg);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    rem -= seg;
  }
  return pts[0] ?? { x: 0, y: 0 };
}

export const samePin = (a: PinRef, b: PinRef): boolean =>
  a.componentId === b.componentId && a.pinId === b.pinId;
