import type { UnitFamily } from "./types";

export const UNIT_SYMBOL: Record<UnitFamily, string> = {
  ohm: "Ω",
  farad: "F",
  henry: "H",
  volt: "V",
  amp: "A",
  hertz: "Hz",
  watt: "W",
  second: "s",
  none: "",
};

interface Prefix {
  sym: string;
  exp: number;
}

const PREFIXES: Prefix[] = [
  { sym: "T", exp: 12 },
  { sym: "G", exp: 9 },
  { sym: "M", exp: 6 },
  { sym: "k", exp: 3 },
  { sym: "", exp: 0 },
  { sym: "m", exp: -3 },
  { sym: "µ", exp: -6 },
  { sym: "n", exp: -9 },
  { sym: "p", exp: -12 },
];

/** Selectable prefixes for the inspector, per unit family. */
export const UNIT_CHOICES: Record<UnitFamily, string[]> = {
  ohm: ["", "k", "M"],
  farad: ["p", "n", "µ", "m"],
  henry: ["µ", "m", ""],
  volt: ["m", "", "k"],
  amp: ["µ", "m", ""],
  hertz: ["", "k", "M"],
  watt: ["m", "", "k"],
  second: ["µ", "m", ""],
  none: [""],
};

export function prefixExp(sym: string): number {
  return PREFIXES.find((p) => p.sym === sym)?.exp ?? 0;
}

/** Pick the engineering prefix that keeps the mantissa in [1, 1000). */
export function bestPrefix(value: number): Prefix {
  const a = Math.abs(value);
  if (a === 0 || !Number.isFinite(a)) return { sym: "", exp: 0 };
  for (const p of PREFIXES) {
    if (a >= 10 ** p.exp * 0.9999999) return p;
  }
  return PREFIXES[PREFIXES.length - 1]!;
}

/** 4700 → "4.7 kΩ". */
export function formatEng(value: number, unit: UnitFamily, digits = 3): string {
  if (!Number.isFinite(value)) return `∞ ${UNIT_SYMBOL[unit]}`.trim();
  const p = bestPrefix(value);
  const mant = value / 10 ** p.exp;
  const s = Number(mant.toPrecision(digits)).toString();
  return `${s} ${p.sym}${UNIT_SYMBOL[unit]}`.trim();
}

export function splitEng(value: number): { mantissa: number; prefix: string } {
  const p = bestPrefix(value);
  return { mantissa: Number((value / 10 ** p.exp).toPrecision(6)), prefix: p.sym };
}

/**
 * Parse engineering notation typed by a person: "4.7k", "10 kΩ", "100uF", "2.2n", "1e-6", "47meg", "4k7", "-5V".
 * Case matters for the SI prefix: "m" is milli, "M" is mega ("meg" is also mega, as in SPICE).
 * Returns NaN when the text cannot be understood.
 */
export function parseEng(text: string): number {
  let t = text
    .trim()
    .replace(/,/g, ".")
    .replace(/\s+/g, "")
    .replace(/meg/gi, "M")
    .replace(/ohms?|hz|farads?|henr(?:y|ies)|volts?|amps?|watts?|sec(?:onds?)?/gi, "")
    .replace(/[ΩωFHVAWs]/g, "");
  // "4k7" → "4.7k" (prefix used as decimal point)
  const rn = /^([+-]?\d+)([TGMkmuµnp])(\d+)$/.exec(t);
  if (rn) t = `${rn[1]}.${rn[3]}${rn[2]}`;
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?)([TGMkmuµnp]?)$/i.exec(t);
  if (!m) return Number.NaN;
  const num = Number(m[1]);
  let sym = m[2] ?? "";
  if (sym === "u") sym = "µ";
  if (sym === "K") sym = "k";
  // lower-case t/g/p/n have no clash; "M" vs "m" keeps its case
  if (sym === "t") sym = "T";
  if (sym === "g") sym = "G";
  if (sym === "P") sym = "p";
  if (sym === "N") sym = "n";
  return Number.isFinite(num) ? Number((num * 10 ** prefixExp(sym)).toPrecision(12)) : Number.NaN;
}

export function formatTime(seconds: number): string {
  return formatEng(seconds, "second", 4);
}
