"use client";

import { ChevronDown, ChevronRight, Search, X } from "lucide-react";
import { useMemo } from "react";
import { CATEGORIES, CATALOG_LIST, searchCatalog } from "@/models/catalog";
import type { CategoryId, ComponentDef } from "@/models/types";
import { useUiStore } from "@/store/uiStore";
import { cn } from "@/lib/utils";
import { DND_MIME } from "../canvas/CircuitCanvas";
import { Input } from "../primitives/input";
import { PartPreview } from "./PartPreview";

function PartRow({ def, armed }: { def: ComponentDef; armed: boolean }): React.JSX.Element {
  const setPlacing = useUiStore((s) => s.setPlacing);
  return (
    <button
      type="button"
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData(DND_MIME, def.kind);
        e.dataTransfer.effectAllowed = "copy";
      }}
      onClick={() => setPlacing(armed ? null : def.kind)}
      title={def.description}
      className={cn(
        "group flex w-full items-center gap-2 border-b border-bg-line/60 px-2 py-1.5 text-left transition-colors hover:bg-bg-raised",
        armed && "bg-neon-cyan/10 outline outline-1 -outline-offset-1 outline-neon-cyan/60",
      )}
    >
      <div className="flex shrink-0 gap-px">
        <PartPreview def={def} view="schematic" width={56} height={36} />
        <PartPreview def={def} view="physical" width={56} height={36} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="truncate font-mono text-[11px] text-ink">{def.name}</div>
        <div className="truncate text-[10px] text-ink-faint">{def.description}</div>
      </div>
    </button>
  );
}

export function Sidebar(): React.JSX.Element {
  const search = useUiStore((s) => s.search);
  const setSearch = useUiStore((s) => s.setSearch);
  const open = useUiStore((s) => s.openCategories);
  const toggle = useUiStore((s) => s.toggleCategory);
  const placing = useUiStore((s) => s.placingKind);

  const results = useMemo(() => searchCatalog(search), [search]);
  const searching = search.trim().length > 0;

  const byCat = useMemo(() => {
    const m = new Map<CategoryId, ComponentDef[]>();
    for (const c of CATEGORIES) m.set(c.id, []);
    for (const d of results) {
      m.get(d.category)?.push(d);
      for (const extra of d.alsoIn ?? []) m.get(extra)?.push(d);
    }
    return m;
  }, [results]);

  return (
    <aside className="flex h-full w-[300px] shrink-0 flex-col border-r border-bg-line bg-bg-panel">
      <div className="border-b border-bg-line p-2">
        <div className="panel-title mb-1.5 flex items-center justify-between">
          <span>Component library</span>
          <span className="text-ink-faint">{CATALOG_LIST.length} parts</span>
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1.5 h-3.5 w-3.5 text-ink-faint" />
          <Input
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search: resistor, 555, led…"
            className="pl-7 pr-7"
            aria-label="Search components"
          />
          {search && (
            <button
              type="button"
              onClick={() => setSearch("")}
              className="absolute right-1.5 top-1.5 text-ink-faint hover:text-ink"
              aria-label="Clear search"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          )}
        </div>
        <div className="mt-1.5 font-mono text-[10px] text-ink-faint">
          Drag onto canvas, or click to arm · <span className="kbd">R</span> rotate · <span className="kbd">F</span> flip
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {CATEGORIES.map((cat) => {
          const list = byCat.get(cat.id) ?? [];
          if (searching && list.length === 0) return null;
          const isOpen = searching || open[cat.id];
          return (
            <section key={cat.id}>
              <button
                type="button"
                onClick={() => toggle(cat.id)}
                className="flex w-full items-center gap-1.5 border-b border-bg-line bg-bg px-2 py-1.5 text-left hover:bg-bg-raised"
              >
                {isOpen ? <ChevronDown className="h-3.5 w-3.5 text-ink-dim" /> : <ChevronRight className="h-3.5 w-3.5 text-ink-dim" />}
                <span className="h-2 w-2" style={{ background: cat.accent }} />
                <span className="panel-title flex-1 !text-ink">{cat.label}</span>
                <span className="font-mono text-[10px] text-ink-faint">{list.length}</span>
              </button>
              {isOpen && list.map((d) => <PartRow key={`${cat.id}-${d.kind}`} def={d} armed={placing === d.kind} />)}
            </section>
          );
        })}
        {searching && results.length === 0 && (
          <div className="p-4 text-center font-mono text-[11px] text-ink-faint">No parts match “{search}”.</div>
        )}
      </div>
    </aside>
  );
}
