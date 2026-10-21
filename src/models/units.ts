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
 * Parse "4.7k", "10 kΩ", "100n", "2u2"-style is not supported on purpose.
 * Returns NaN when the text cannot be understood.
 */
export function parseEng(text: string): number {
  const t = text.trim().replace(/[ΩωFHVAWs]|Hz|ohm(s)?/g, "").replace(/\s+/g, "");
  const m = /^([+-]?\d*\.?\d+(?:e[+-]?\d+)?)([TGMkmuµnp]?)$/i.exec(t);
  if (!m) return Number.NaN;
  const num = Number(m[1]);
  let sym = m[2] ?? "";
  if (sym === "u") sym = "µ";
  // "m" is milli, "M" is mega – case matters.
  return num * 10 ** prefixExp(sym);
}

export function formatTime(seconds: number): string {
  return formatEng(seconds, "second", 4);
}
