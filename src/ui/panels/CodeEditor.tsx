"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { getDef } from "@/models/catalog";
import { compileCached } from "@/engine/mcuDevice";
import { getIo } from "@/mcu/io";
import { TEMPLATES } from "@/mcu/templates";
import { cn } from "@/lib/utils";
import { useCircuitStore } from "@/store/circuitStore";
import { useUiStore } from "@/store/uiStore";

const Monaco = dynamic(() => import("@monaco-editor/react").then((m) => m.default), { ssr: false });

/** MCU components currently on the canvas. */
export function useMcus(): { id: string; label: string; kind: string }[] {
  const comps = useCircuitStore((s) => s.components);
  return useMemo(
    () => comps.filter((c) => getDef(c.kind)?.sim === "mcu").map((c) => ({ id: c.id, label: c.label, kind: c.kind })),
    [comps],
  );
}

export function useCurrentMcu(): { id: string; label: string; kind: string } | undefined {
  const mcus = useMcus();
  const sel = useUiStore((s) => s.mcuId);
  return mcus.find((m) => m.id === sel) ?? mcus[0];
}

export function McuSelect(): React.JSX.Element | null {
  const mcus = useMcus();
  const cur = useCurrentMcu();
  const pick = useUiStore((s) => s.openCode);
  const setTab = useUiStore((s) => s.setDockTab);
  const tab = useUiStore((s) => s.dockTab);
  if (!cur) return null;
  return (
    <select
      value={cur.id}
      onChange={(e) => {
        useUiStore.setState({ mcuId: e.target.value });
        if (tab === "instruments") setTab("code");
        else void pick;
      }}
      className="h-6 border border-bg-line bg-bg px-1 font-mono text-[11px] text-ink"
      aria-label="Microcontroller"
    >
      {mcus.map((m) => (
        <option key={m.id} value={m.id}>{m.label} · {getDef(m.kind)?.name ?? m.kind}</option>
      ))}
    </select>
  );
}

export function CodeEditor(): React.JSX.Element {
  const cur = useCurrentMcu();
  const comp = useCircuitStore((s) => s.components.find((c) => c.id === cur?.id));
  const update = useCircuitStore((s) => s.updateParams);
  const stored = typeof comp?.params.code === "string" ? comp.params.code : "";
  const [text, setText] = useState(stored);
  const [useFallback, setFallback] = useState(false);
  const [ready, setReady] = useState(false);
  const [mounted, setMounted] = useState(false);
  const lastCommitted = useRef(stored);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const editorRef = useRef<{ editor: import("monaco-editor").editor.IStandaloneCodeEditor; monaco: typeof import("monaco-editor") } | null>(null);
  const id = cur?.id;
  const kind = cur?.kind ?? "arduino_uno";

  // External changes (undo, template, load, switching MCU) replace the local text.
  useEffect(() => {
    if (stored !== lastCommitted.current || id) {
      if (stored !== text && stored !== lastCommitted.current) setText(stored);
      lastCommitted.current = stored;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stored, id]);
  useEffect(() => {
    setText(stored);
    lastCommitted.current = stored;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  // Monaco is fetched from a CDN: if that fails (offline, blocked) use a plain textarea instead.
  useEffect(() => {
    let alive = true;
    // The loader rejects with a raw DOM Event when the CDN script cannot be fetched; it is handled above.
    const swallow = (e: PromiseRejectionEvent): void => {
      if (typeof Event !== "undefined" && e.reason instanceof Event) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    };
    window.addEventListener("unhandledrejection", swallow, true);
    void import("@monaco-editor/react").then((m) => {
      const p: Promise<unknown> = m.loader.init();
      p.then(
        () => {
          if (alive) setReady(true);
        },
        () => {
          if (alive) setFallback(true);
        },
      );
    });
    const t = setTimeout(() => {
      if (alive) setFallback((f) => f || !editorRef.current);
    }, 10000);
    return () => {
      alive = false;
      clearTimeout(t);
      setTimeout(() => window.removeEventListener("unhandledrejection", swallow, true), 15000);
    };
  }, []);

  const commit = useCallback(
    (v: string) => {
      if (!id) return;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        lastCommitted.current = v;
        update(id, { code: v }, "code:" + id);
      }, 350);
    },
    [id, update],
  );
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);

  const result = useMemo(() => compileCached(text, kind), [text, kind]);

  // Error markers in the editor.
  useEffect(() => {
    const h = editorRef.current;
    if (!h) return;
    const model = h.editor.getModel();
    if (!model) return;
    h.monaco.editor.setModelMarkers(
      model,
      "sketch",
      result.errors.map((e) => ({
        severity: h.monaco.MarkerSeverity.Error,
        message: e.message,
        startLineNumber: Math.max(1, e.line),
        startColumn: Math.max(1, e.col),
        endLineNumber: Math.max(1, e.line),
        endColumn: Math.max(2, e.col + 1),
      })),
    );
  }, [result, mounted]);

  const io = id ? getIo(id) : null;
  const status = useSyncExternalStore(
    (fn) => (io ? io.subscribe(fn) : () => undefined),
    () => (io ? io.version : 0),
    () => 0,
  );
  void status;

  if (!cur || !id) {
    return <div className="p-3 font-mono text-[11px] text-ink-faint">Place an Arduino Uno, ESP32 or ATtiny85 to write a sketch.</div>;
  }

  const setCode = (v: string): void => {
    setText(v);
    commit(v);
  };

  const loadTemplate = (tid: string): void => {
    const t = TEMPLATES.find((x) => x.id === tid);
    if (!t) return;
    if (timer.current) clearTimeout(timer.current);
    setText(t.code);
    lastCommitted.current = t.code;
    update(id, { code: t.code });
  };

  const rt = io?.status;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-bg-line px-2 py-1 font-mono text-[11px]">
        <McuSelect />
        <select
          value=""
          onChange={(e) => loadTemplate(e.target.value)}
          className="h-6 border border-bg-line bg-bg px-1 text-ink"
          aria-label="Load example"
        >
          <option value="">Load example…</option>
          {TEMPLATES.map((t) => (
            <option key={t.id} value={t.id}>{t.name} — {t.description}</option>
          ))}
        </select>
        <span className={cn("px-1.5 py-0.5", result.ok ? "bg-neon-green/10 text-neon-green" : "bg-neon-red/10 text-neon-red")}>
          {result.ok ? "Compiled OK" : `${result.errors.length} error${result.errors.length === 1 ? "" : "s"}`}
        </span>
        {rt && rt.kind !== "idle" && (
          <span className={cn("px-1.5 py-0.5", rt.kind === "running" ? "text-neon-cyan" : rt.kind === "error" ? "text-neon-red" : "text-ink-faint")}>
            {rt.kind === "running" ? "● running" : rt.kind === "off" ? "○ unpowered" : "✕ " + rt.message}
          </span>
        )}
        <span className="ml-auto text-ink-faint">Edits apply instantly; the sketch restarts when the code changes.</span>
      </div>
      <div className="min-h-0 flex-1">
        {useFallback || !ready ? (
          <textarea
            value={text}
            onChange={(e) => setCode(e.target.value)}
            spellCheck={false}
            className="h-full w-full resize-none bg-bg p-2 font-mono text-[12px] leading-snug text-ink outline-none"
            readOnly={!useFallback}
            aria-label="Sketch source"
          />
        ) : (
          <Monaco
            height="100%"
            language="cpp"
            theme="vs-dark"
            path={`sketch-${id}.ino`}
            value={text}
            onChange={(v) => setCode(v ?? "")}
            onMount={(editor, monaco) => {
              editorRef.current = { editor, monaco: monaco as unknown as typeof import("monaco-editor") };
              setMounted(true);
            }}
            options={{
              minimap: { enabled: false },
              fontSize: 12,
              scrollBeyondLastLine: false,
              automaticLayout: true,
              tabSize: 2,
              renderWhitespace: "none",
            }}
          />
        )}
      </div>
      {!result.ok && (
        <div className="max-h-[72px] shrink-0 overflow-y-auto border-t border-bg-line bg-bg px-2 py-1 font-mono text-[11px] text-neon-red">
          {result.errors.slice(0, 8).map((e, i) => (
            <button
              key={i}
              type="button"
              className="block w-full text-left hover:bg-bg-raised"
              onClick={() => {
                const h = editorRef.current;
                if (h) {
                  h.editor.revealLineInCenter(e.line);
                  h.editor.setPosition({ lineNumber: Math.max(1, e.line), column: Math.max(1, e.col) });
                  h.editor.focus();
                }
              }}
            >
              line {e.line}:{e.col} — {e.message}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
