/** Board descriptions: Arduino pin numbers ↔ catalog pin ids, electrical levels and timing costs. */

export type BoardKind = "arduino_uno" | "esp32" | "attiny85";

export interface BoardCosts {
  /** seconds charged per call */
  digitalWrite: number;
  digitalRead: number;
  analogRead: number;
  analogWrite: number;
  pinMode: number;
  /** cost of one loop iteration / function call used to keep busy loops advancing */
  tick: number;
}

export interface BoardSpec {
  kind: BoardKind;
  name: string;
  intBits: 16 | 32;
  /** logic-high level when powered normally */
  vhigh: number;
  adcBits: number;
  /** Arduino pin number → catalog pin id */
  pins: Map<number, string>;
  /** pins with hardware PWM (all output-capable pins when `allPwm`) */
  pwmPins: Set<number>;
  allPwm: boolean;
  inputOnly: Set<number>;
  pwmHz: (pin: number) => number;
  constants: Record<string, number>;
  predefined: Record<string, string>;
  costs: BoardCosts;
  /** output driver resistance in ohms */
  rout: number;
  /** pin ids carrying power / ground (not GPIO) */
  gndPins: string[];
}

const AVR_COSTS: BoardCosts = {
  digitalWrite: 5e-6,
  digitalRead: 5e-6,
  analogRead: 112e-6,
  analogWrite: 6e-6,
  pinMode: 3e-6,
  tick: 1.5e-6,
};

function unoSpec(): BoardSpec {
  const pins = new Map<number, string>();
  for (let i = 0; i <= 13; i++) pins.set(i, `d${i}`);
  for (let i = 0; i <= 5; i++) pins.set(14 + i, `a${i}`);
  const constants: Record<string, number> = { LED_BUILTIN: 13, SDA: 18, SCL: 19, SS: 10, MOSI: 11, MISO: 12, SCK: 13 };
  for (let i = 0; i <= 5; i++) constants[`A${i}`] = 14 + i;
  for (let i = 0; i <= 13; i++) constants[`D${i}`] = i;
  return {
    kind: "arduino_uno",
    name: "Arduino Uno",
    intBits: 16,
    vhigh: 5,
    adcBits: 10,
    pins,
    pwmPins: new Set([3, 5, 6, 9, 10, 11]),
    allPwm: false,
    inputOnly: new Set(),
    pwmHz: (p) => (p === 5 || p === 6 ? 976 : 490),
    constants,
    predefined: {
      ARDUINO: "10819",
      ARDUINO_AVR_UNO: "1",
      ARDUINO_ARCH_AVR: "1",
      __AVR_ATmega328P__: "1",
      __AVR__: "1",
      F_CPU: "16000000L",
    },
    costs: AVR_COSTS,
    rout: 25,
    gndPins: ["gnd1", "gnd2", "gnd3"],
  };
}

function esp32Spec(): BoardSpec {
  const labels: [number, string][] = [];
  const left = ["EN", "3V3", "GND", "VIN", "G36", "G39", "G34", "G35", "G32", "G33", "G25", "G26", "G27", "G14", "G12"];
  const right = ["GND", "G23", "G22", "TX", "RX", "G21", "G19", "G18", "G5", "G17", "G16", "G4", "G0", "G2", "G15"];
  const pins = new Map<number, string>();
  void labels;
  for (const l of left) {
    const m = /^G(\d+)$/.exec(l);
    if (m) pins.set(Number(m[1]), l.toLowerCase());
  }
  for (const l of right) {
    const m = /^G(\d+)$/.exec(l);
    if (m) pins.set(Number(m[1]), `r_${l.toLowerCase()}`);
    else if (l === "TX") pins.set(1, "r_tx");
    else if (l === "RX") pins.set(3, "r_rx");
  }
  const constants: Record<string, number> = {
    LED_BUILTIN: 2, BUILTIN_LED: 2, A0: 36, A3: 39, A4: 32, A5: 33, A6: 34, A7: 35, A10: 4, A11: 0, A12: 2, A13: 15,
    A14: 13, A15: 12, A16: 14, A17: 27, A18: 25, A19: 26, TX: 1, RX: 3, SDA: 21, SCL: 22, INPUT_PULLDOWN: 3,
  };
  for (const n of pins.keys()) constants[`D${n}`] = n;
  return {
    kind: "esp32",
    name: "ESP32 DevKit",
    intBits: 32,
    vhigh: 3.3,
    adcBits: 12,
    pins,
    pwmPins: new Set(),
    allPwm: true,
    inputOnly: new Set([34, 35, 36, 39]),
    pwmHz: () => 1000,
    constants,
    predefined: {
      ESP32: "1",
      ARDUINO_ARCH_ESP32: "1",
      ESP_PLATFORM: "1",
      ARDUINO: "10812",
      F_CPU: "240000000L",
    },
    costs: { digitalWrite: 0.6e-6, digitalRead: 0.6e-6, analogRead: 40e-6, analogWrite: 2e-6, pinMode: 1e-6, tick: 0.1e-6 },
    rout: 30,
    gndPins: ["gnd", "r_gnd"],
  };
}

function attinySpec(): BoardSpec {
  // DIP-8: p1 PB5, p2 PB3, p3 PB4, p4 GND, p5 PB0, p6 PB1, p7 PB2, p8 VCC
  const pins = new Map<number, string>([
    [5, "p1"],
    [3, "p2"],
    [4, "p3"],
    [0, "p5"],
    [1, "p6"],
    [2, "p7"],
  ]);
  return {
    kind: "attiny85",
    name: "ATtiny85",
    intBits: 16,
    vhigh: 5,
    adcBits: 10,
    pins,
    pwmPins: new Set([0, 1, 4]),
    allPwm: false,
    inputOnly: new Set(),
    pwmHz: () => 490,
    constants: { LED_BUILTIN: 1, A0: 5, A1: 2, A2: 4, A3: 3, PB0: 0, PB1: 1, PB2: 2, PB3: 3, PB4: 4, PB5: 5 },
    predefined: {
      ARDUINO: "10819",
      ARDUINO_attiny: "1",
      __AVR_ATtiny85__: "1",
      __AVR__: "1",
      F_CPU: "8000000L",
    },
    costs: { ...AVR_COSTS, digitalWrite: 8e-6, digitalRead: 8e-6, analogRead: 112e-6, tick: 3e-6 },
    rout: 25,
    gndPins: ["p4"],
  };
}

const cache = new Map<BoardKind, BoardSpec>();
export function boardFor(kind: string): BoardSpec | null {
  if (kind !== "arduino_uno" && kind !== "esp32" && kind !== "attiny85") return null;
  let b = cache.get(kind);
  if (!b) {
    b = kind === "arduino_uno" ? unoSpec() : kind === "esp32" ? esp32Spec() : attinySpec();
    cache.set(kind, b);
  }
  return b;
}
