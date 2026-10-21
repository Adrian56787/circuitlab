import { create } from "zustand";
import { getDef } from "@/models/catalog";
import { samePin } from "@/models/geometry";
import type {
  CircuitData,
  Params,
  ParamValue,
  PinRef,
  PlacedComponent,
  Rotation,
  Wire,
  WireColor,
  WireRouting,
} from "@/models/types";
import { uid } from "@/lib/id";

interface Snapshot {
  components: PlacedComponent[];
  wires: Wire[];
}

export interface Selection {
  components: string[];
  wires: string[];
}

interface CircuitState {
  name: string;
  components: PlacedComponent[];
  wires: Wire[];
  selection: Selection;
  past: Snapshot[];
  future: Snapshot[];
  /** Bumps on every structural/param change; used by the simulator to recompile. */
  revision: number;

  // history
  checkpoint: () => void;
  undo: () => void;
  redo: () => void;

  // components
  addComponent: (kind: string, x: number, y: number, params?: Params) => string;
  moveComponents: (ids: string[], dx: number, dy: number) => void;
  setComponentPosition: (id: string, x: number, y: number) => void;
  rotateSelection: () => void;
  mirrorSelection: () => void;
  updateParams: (id: string, patch: Params, coalesceKey?: string) => void;
  /** Change params without recording history or touching selection (runtime interaction). */
  setRuntimeParam: (id: string, key: string, value: ParamValue) => void;
  setLabel: (id: string, label: string) => void;
  duplicateSelection: () => void;
  deleteSelection: () => void;

  // wires
  addWire: (from: PinRef, to: PinRef, color?: WireColor, routing?: WireRouting) => string | null;
  setWireColor: (id: string, color: WireColor, custom?: string) => void;
  setWireRouting: (id: string, routing: WireRouting) => void;

  // selection
  select: (sel: Partial<Selection>, additive?: boolean) => void;
  clearSelection: () => void;
  selectAll: () => void;

  // io
  load: (data: CircuitData) => void;
  clear: () => void;
  toData: () => CircuitData;
}

const MAX_HISTORY = 120;

const snapshotOf = (s: Pick<CircuitState, "components" | "wires">): Snapshot => ({
  components: s.components,
  wires: s.wires,
});

let lastCoalesce: { key: string; at: number } | null = null;

function nextLabel(components: PlacedComponent[], kind: string): string {
  const prefix = getDef(kind).prefix;
  let max = 0;
  for (const c of components) {
    if (getDef(c.kind).prefix !== prefix) continue;
    const m = new RegExp(`^${prefix}(\\d+)$`).exec(c.label);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return prefix === "GND" ? "GND" : `${prefix}${max + 1}`;
}

export const useCircuitStore = create<CircuitState>((set, get) => ({
  name: "Untitled circuit",
  components: [],
  wires: [],
  selection: { components: [], wires: [] },
  past: [],
  future: [],
  revision: 0,

  checkpoint: () => {
    lastCoalesce = null;
    set((s) => ({
      past: [...s.past.slice(-(MAX_HISTORY - 1)), snapshotOf(s)],
      future: [],
    }));
  },

  undo: () =>
    set((s) => {
      const prev = s.past[s.past.length - 1];
      if (!prev) return s;
      lastCoalesce = null;
      return {
        components: prev.components,
        wires: prev.wires,
        past: s.past.slice(0, -1),
        future: [snapshotOf(s), ...s.future],
        selection: { components: [], wires: [] },
        revision: s.revision + 1,
      };
    }),

  redo: () =>
    set((s) => {
      const next = s.future[0];
      if (!next) return s;
      lastCoalesce = null;
      return {
        components: next.components,
        wires: next.wires,
        past: [...s.past, snapshotOf(s)],
        future: s.future.slice(1),
        selection: { components: [], wires: [] },
        revision: s.revision + 1,
      };
    }),

  addComponent: (kind, x, y, params) => {
    const def = getDef(kind);
    const id = uid("c");
    get().checkpoint();
    set((s) => ({
      components: [
        ...s.components,
        {
          id,
          kind,
          x,
          y,
          rotation: 0,
          mirror: false,
          params: { ...def.defaults, ...params },
          label: nextLabel(s.components, kind),
        },
      ],
      selection: { components: [id], wires: [] },
      revision: s.revision + 1,
    }));
    return id;
  },

  moveComponents: (ids, dx, dy) =>
    set((s) => {
      const set_ = new Set(ids);
      return {
        components: s.components.map((c) => (set_.has(c.id) ? { ...c, x: c.x + dx, y: c.y + dy } : c)),
        revision: s.revision + 1,
      };
    }),

  setComponentPosition: (id, x, y) =>
    set((s) => ({
      components: s.components.map((c) => (c.id === id ? { ...c, x, y } : c)),
      revision: s.revision + 1,
    })),

  rotateSelection: () => {
    const ids = new Set(get().selection.components);
    if (ids.size === 0) return;
    get().checkpoint();
    set((s) => ({
      components: s.components.map((c) =>
        ids.has(c.id) ? { ...c, rotation: ((c.rotation + 90) % 360) as Rotation } : c,
      ),
      revision: s.revision + 1,
    }));
  },

  mirrorSelection: () => {
    const ids = new Set(get().selection.components);
    if (ids.size === 0) return;
    get().checkpoint();
    set((s) => ({
      components: s.components.map((c) => (ids.has(c.id) ? { ...c, mirror: !c.mirror } : c)),
      revision: s.revision + 1,
    }));
  },

  updateParams: (id, patch, coalesceKey) => {
    const now = Date.now();
    const coalesce = coalesceKey && lastCoalesce && lastCoalesce.key === coalesceKey && now - lastCoalesce.at < 900;
    if (!coalesce) get().checkpoint();
    lastCoalesce = coalesceKey ? { key: coalesceKey, at: now } : null;
    set((s) => ({
      components: s.components.map((c) => (c.id === id ? { ...c, params: { ...c.params, ...patch } } : c)),
      revision: s.revision + 1,
    }));
  },

  setRuntimeParam: (id, key, value) =>
    set((s) => ({
      components: s.components.map((c) => (c.id === id ? { ...c, params: { ...c.params, [key]: value } } : c)),
      revision: s.revision + 1,
    })),

  setLabel: (id, label) => {
    get().checkpoint();
    set((s) => ({ components: s.components.map((c) => (c.id === id ? { ...c, label } : c)) }));
  },

  duplicateSelection: () => {
    const { selection, components, wires } = get();
    if (selection.components.length === 0) return;
    get().checkpoint();
    const idMap = new Map<string, string>();
    const copies: PlacedComponent[] = [];
    let working = components;
    for (const id of selection.components) {
      const src = components.find((c) => c.id === id);
      if (!src) continue;
      const nid = uid("c");
      idMap.set(id, nid);
      const copy: PlacedComponent = {
        ...src,
        id: nid,
        x: src.x + 2,
        y: src.y + 2,
        params: { ...src.params },
        label: nextLabel(working, src.kind),
      };
      working = [...working, copy];
      copies.push(copy);
    }
    const wireCopies: Wire[] = wires
      .filter((w) => idMap.has(w.from.componentId) && idMap.has(w.to.componentId))
      .map((w) => ({
        ...w,
        id: uid("w"),
        from: { ...w.from, componentId: idMap.get(w.from.componentId)! },
        to: { ...w.to, componentId: idMap.get(w.to.componentId)! },
      }));
    set((s) => ({
      components: [...s.components, ...copies],
      wires: [...s.wires, ...wireCopies],
      selection: { components: copies.map((c) => c.id), wires: [] },
      revision: s.revision + 1,
    }));
  },

  deleteSelection: () => {
    const { selection } = get();
    if (selection.components.length === 0 && selection.wires.length === 0) return;
    get().checkpoint();
    const comps = new Set(selection.components);
    const ws = new Set(selection.wires);
    set((s) => ({
      components: s.components.filter((c) => !comps.has(c.id)),
      wires: s.wires.filter((w) => !ws.has(w.id) && !comps.has(w.from.componentId) && !comps.has(w.to.componentId)),
      selection: { components: [], wires: [] },
      revision: s.revision + 1,
    }));
  },

  addWire: (from, to, color = "auto", routing = "orthogonal") => {
    if (samePin(from, to)) return null;
    const { wires } = get();
    if (wires.some((w) => (samePin(w.from, from) && samePin(w.to, to)) || (samePin(w.from, to) && samePin(w.to, from)))) {
      return null;
    }
    const id = uid("w");
    get().checkpoint();
    set((s) => ({
      wires: [...s.wires, { id, from, to, color, routing }],
      revision: s.revision + 1,
    }));
    return id;
  },

  setWireColor: (id, color, custom) => {
    get().checkpoint();
    set((s) => ({
      wires: s.wires.map((w) => (w.id === id ? { ...w, color, custom } : w)),
      revision: s.revision + 1,
    }));
  },

  setWireRouting: (id, routing) => {
    get().checkpoint();
    set((s) => ({ wires: s.wires.map((w) => (w.id === id ? { ...w, routing } : w)) }));
  },

  select: (sel, additive = false) =>
    set((s) => {
      const comps = sel.components ?? [];
      const ws = sel.wires ?? [];
      if (!additive) return { selection: { components: comps, wires: ws } };
      const toggle = (cur: string[], add: string[]): string[] => {
        const next = new Set(cur);
        for (const id of add) {
          if (next.has(id)) next.delete(id);
          else next.add(id);
        }
        return [...next];
      };
      return {
        selection: {
          components: toggle(s.selection.components, comps),
          wires: toggle(s.selection.wires, ws),
        },
      };
    }),

  clearSelection: () => set({ selection: { components: [], wires: [] } }),

  selectAll: () =>
    set((s) => ({
      selection: { components: s.components.map((c) => c.id), wires: s.wires.map((w) => w.id) },
    })),

  load: (data) =>
    set((s) => ({
      name: data.name,
      components: data.components,
      wires: data.wires,
      selection: { components: [], wires: [] },
      past: [],
      future: [],
      revision: s.revision + 1,
    })),

  clear: () => {
    get().checkpoint();
    set((s) => ({
      components: [],
      wires: [],
      selection: { components: [], wires: [] },
      revision: s.revision + 1,
    }));
  },

  toData: () => {
    const { name, components, wires } = get();
    return { version: 1, name, components, wires };
  },
}));
