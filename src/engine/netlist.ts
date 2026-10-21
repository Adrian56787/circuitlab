import { CATALOG } from "@/models/catalog";
import { pinKey } from "@/models/types";
import type { PlacedComponent, Wire } from "@/models/types";

export interface NetInfo {
  id: string;
  pins: string[];
  hasGround: boolean;
  /** Net touches a power-kind pin (source +, VCC...). */
  hasPower: boolean;
  /** Net touches a logic-IC signal pin. */
  digital: boolean;
}

export interface Netlist {
  nets: Map<string, NetInfo>;
  pinNet: Map<string, string>;
  groundNet: string | null;
}

class UnionFind {
  private parent = new Map<string, string>();
  find(a: string): string {
    if (!this.parent.has(a)) {
      this.parent.set(a, a);
      return a;
    }
    let root = a;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    // path compression
    let cur = a;
    while (cur !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

const DIGITAL_MODELS = new Set(["gate", "timer555", "mcu"]);

/** Merge pins joined by wires into electrical nets. */
export function buildNetlist(components: readonly PlacedComponent[], wires: readonly Wire[]): Netlist {
  const uf = new UnionFind();
  const allPins: { key: string; comp: PlacedComponent; pinId: string }[] = [];

  for (const c of components) {
    const def = CATALOG.get(c.kind);
    if (!def) continue;
    for (const p of def.pins) {
      const key = pinKey({ componentId: c.id, pinId: p.id });
      uf.find(key);
      allPins.push({ key, comp: c, pinId: p.id });
    }
  }
  // Every ground symbol is the same 0 V node, wired or not.
  let firstGround: string | null = null;
  for (const { key, comp } of allPins) {
    if (CATALOG.get(comp.kind)?.sim !== "ground") continue;
    if (firstGround === null) firstGround = key;
    else uf.union(firstGround, key);
  }
  for (const w of wires) {
    const a = pinKey(w.from);
    const b = pinKey(w.to);
    if (!uf.find(a) || !uf.find(b)) continue;
    uf.union(a, b);
  }

  // Group by root, number deterministically by first pin encountered.
  const roots = new Map<string, string>();
  const nets = new Map<string, NetInfo>();
  const pinNet = new Map<string, string>();
  let groundNet: string | null = null;

  for (const { key, comp, pinId } of allPins) {
    const root = uf.find(key);
    let id = roots.get(root);
    if (!id) {
      id = `n${roots.size}`;
      roots.set(root, id);
      nets.set(id, { id, pins: [], hasGround: false, hasPower: false, digital: false });
    }
    pinNet.set(key, id);
    const net = nets.get(id)!;
    net.pins.push(key);
    const def = CATALOG.get(comp.kind)!;
    const pd = def.pins.find((p) => p.id === pinId)!;
    if (def.sim === "ground") {
      net.hasGround = true;
      groundNet = id;
    }
    if (pd.kind === "power") net.hasPower = true;
    if (DIGITAL_MODELS.has(def.sim) && (pd.kind === "input" || pd.kind === "output" || pd.kind === "io")) {
      net.digital = true;
    }
  }

  return { nets, pinNet, groundNet };
}
