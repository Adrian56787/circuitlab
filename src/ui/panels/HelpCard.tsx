"use client";

import { getDef } from "@/models/catalog";
import { getHelp } from "@/models/help";
import { cn } from "@/lib/utils";

/** Educational card for a part: definition, behaviour, formulas, truth table and typical uses. */
export function HelpCard({ kind, compact = false, className }: { kind: string; compact?: boolean; className?: string }): React.JSX.Element {
  const def = getDef(kind);
  const h = getHelp(kind, def.description);
  return (
    <div className={cn("space-y-2 text-[11px] leading-snug text-ink-dim", className)}>
      <p className="text-ink">{h.what}</p>
      {h.how && <p>{h.how}</p>}
      {h.formulas.length > 0 && (
        <div>
          <div className="mb-0.5 font-mono text-[9px] uppercase tracking-wider text-ink-faint">Key formulas</div>
          <ul className="space-y-0.5 border border-bg-line bg-bg px-2 py-1.5 font-mono text-[11px] text-neon-cyan">
            {h.formulas.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </div>
      )}
      {h.table && (
        <table className="w-full border-collapse border border-bg-line text-center font-mono text-[11px]">
          <thead>
            <tr className="bg-bg">
              {h.table.head.map((c) => (
                <th key={c} className="border border-bg-line px-2 py-0.5 text-ink-faint">
                  {c}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {h.table.rows.map((r, i) => (
              <tr key={i}>
                {r.map((c, j) => (
                  <td key={j} className={cn("border border-bg-line px-2 py-0.5", j === r.length - 1 ? "text-neon-green" : "text-ink")}>
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!compact && h.uses.length > 0 && (
        <div>
          <div className="mb-0.5 font-mono text-[9px] uppercase tracking-wider text-ink-faint">Typical uses</div>
          <ul className="list-disc space-y-0.5 pl-4 marker:text-ink-faint">
            {h.uses.map((u) => (
              <li key={u}>{u}</li>
            ))}
          </ul>
        </div>
      )}
      {h.tip && (
        <p className="border-l-2 border-neon-amber/70 pl-2 text-neon-amber">
          <span className="font-mono text-[9px] uppercase tracking-wider">Tip · </span>
          {h.tip}
        </p>
      )}
    </div>
  );
}
