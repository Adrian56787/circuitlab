"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { getIo } from "@/mcu/io";
import { cn } from "@/lib/utils";
import { McuSelect, useCurrentMcu } from "./CodeEditor";

export function SerialMonitor(): React.JSX.Element {
  const cur = useCurrentMcu();
  const id = cur?.id ?? "";
  const io = getIo(id);
  useSyncExternalStore(
    (fn) => io.subscribe(fn),
    () => io.version,
    () => 0,
  );
  const [line, setLine] = useState("");
  const [auto, setAuto] = useState(true);
  const box = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (auto && box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [io.version, auto]);

  if (!cur) {
    return <div className="p-3 font-mono text-[11px] text-ink-faint">No microcontroller in the circuit.</div>;
  }

  const send = (): void => {
    if (!line) return;
    io.sendLine(line);
    setLine("");
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-bg-line px-2 py-1 font-mono text-[11px]">
        <McuSelect />
        <span className={cn(io.status.kind === "running" ? "text-neon-cyan" : io.status.kind === "error" ? "text-neon-red" : "text-ink-faint")}>
          {io.status.kind === "running" ? `● ${io.baud} baud` : io.status.kind === "error" ? `✕ ${io.status.message}` : io.status.kind === "off" ? "○ unpowered" : "idle"}
        </span>
        <label className="ml-auto flex items-center gap-1 text-ink-dim">
          <input type="checkbox" checked={auto} onChange={(e) => setAuto(e.target.checked)} /> Autoscroll
        </label>
        <button type="button" onClick={() => io.clear()} className="border border-bg-line px-2 py-0.5 text-ink-dim hover:bg-bg-raised hover:text-ink">
          Clear
        </button>
      </div>
      <pre ref={box} className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-all bg-bg p-2 font-mono text-[12px] leading-snug text-neon-green">
        {io.log || <span className="text-ink-faint">Serial output appears here once the simulation runs and the sketch calls Serial.begin().</span>}
      </pre>
      <form
        className="flex shrink-0 gap-2 border-t border-bg-line p-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={line}
          onChange={(e) => setLine(e.target.value)}
          placeholder="Send to the board (newline appended)…"
          className="h-7 min-w-0 flex-1 border border-bg-line bg-bg px-2 font-mono text-[12px] text-ink outline-none focus:border-neon-cyan"
        />
        <button type="submit" className="border border-bg-line px-3 font-mono text-[11px] text-ink hover:bg-bg-raised">Send</button>
      </form>
    </div>
  );
}
