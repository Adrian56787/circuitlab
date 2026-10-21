/** Resistor colour-code helpers (4-band and 5-band). */

export interface ColorBand {
  name: string;
  hex: string;
  digit?: number;
  multiplier?: number;
  tolerance?: number;
}

export const BAND_COLORS: ColorBand[] = [
  { name: "Black", hex: "#111111", digit: 0, multiplier: 1 },
  { name: "Brown", hex: "#7a4a21", digit: 1, multiplier: 10, tolerance: 1 },
  { name: "Red", hex: "#d62d2d", digit: 2, multiplier: 100, tolerance: 2 },
  { name: "Orange", hex: "#ee7d1a", digit: 3, multiplier: 1e3 },
  { name: "Yellow", hex: "#f2d21b", digit: 4, multiplier: 1e4 },
  { name: "Green", hex: "#2f9e44", digit: 5, multiplier: 1e5, tolerance: 0.5 },
  { name: "Blue", hex: "#2b66d9", digit: 6, multiplier: 1e6, tolerance: 0.25 },
  { name: "Violet", hex: "#8a3fd1", digit: 7, multiplier: 1e7, tolerance: 0.1 },
  { name: "Grey", hex: "#8b8f96", digit: 8, multiplier: 1e8, tolerance: 0.05 },
  { name: "White", hex: "#f4f4f4", digit: 9, multiplier: 1e9 },
  { name: "Gold", hex: "#c9a227", multiplier: 0.1, tolerance: 5 },
  { name: "Silver", hex: "#b8bcc2", multiplier: 0.01, tolerance: 10 },
];

const byName = (n: string): ColorBand => BAND_COLORS.find((c) => c.name === n)!;

export interface BandResult {
  bands: ColorBand[];
  tolerance: number;
}

/** Convert a resistance into 4 or 5 colour bands. */
export function resistanceToBands(ohms: number, tolerance = 5, fiveBand = false): BandResult {
  const tolBand =
    BAND_COLORS.find((c) => c.tolerance === tolerance) ?? byName("Gold");
  if (!(ohms > 0)) {
    return { bands: [byName("Black"), byName("Black"), byName("Black"), tolBand], tolerance };
  }
  const sig = fiveBand ? 3 : 2;
  let exp = Math.floor(Math.log10(ohms)) - (sig - 1);
  let mant = Math.round(ohms / 10 ** exp);
  if (mant >= 10 ** sig) {
    mant = Math.round(mant / 10);
    exp += 1;
  }
  const digits = String(mant).padStart(sig, "0").split("").map(Number);
  const digitBands = digits.map((d) => BAND_COLORS.find((c) => c.digit === d)!);

  let mulBand = BAND_COLORS.find((c) => c.multiplier === 10 ** exp);
  if (!mulBand) mulBand = exp === -1 ? byName("Gold") : exp === -2 ? byName("Silver") : byName("Black");
  return { bands: [...digitBands, mulBand, tolBand], tolerance };
}

export function bandsToResistance(names: string[]): { ohms: number; tolerance: number } {
  const fiveBand = names.length === 5;
  const nDigits = fiveBand ? 3 : 2;
  let value = 0;
  for (let i = 0; i < nDigits; i++) value = value * 10 + (byName(names[i]!).digit ?? 0);
  const mul = byName(names[nDigits]!).multiplier ?? 1;
  const tol = byName(names[nDigits + 1]!).tolerance ?? 20;
  return { ohms: value * mul, tolerance: tol };
}
