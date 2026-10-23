import { getDef } from "@/models/catalog";
import { templateById } from "@/mcu/templates";
import type { CircuitData, Params, PlacedComponent, Rotation, Wire } from "@/models/types";

/** Tiny builder so preset layouts read like a netlist. */
class Builder {
  private comps: PlacedComponent[] = [];
  private wires: Wire[] = [];
  private counters: Record<string, number> = {};

  add(kind: string, x: number, y: number, params: Params = {}, rotation: Rotation = 0, label?: string, mirror = false): string {
    const def = getDef(kind);
    const n = (this.counters[def.prefix] = (this.counters[def.prefix] ?? 0) + 1);
    const id = `${kind}_${this.comps.length}`;
    this.comps.push({
      id,
      kind,
      x,
      y,
      rotation,
      mirror,
      params: { ...def.defaults, ...params },
      label: label ?? (def.prefix === "GND" ? "GND" : `${def.prefix}${n}`),
    });
    return id;
  }

  wire(a: string, pa: string, b: string, pb: string): void {
    for (const [id, pin] of [[a, pa], [b, pb]] as const) {
      const comp = this.comps.find((c) => c.id === id);
      if (!comp) throw new Error(`Preset wire references unknown component ${id}`);
      if (!getDef(comp.kind).pins.some((q) => q.id === pin)) {
        throw new Error(`Preset wire: ${comp.kind} has no pin "${pin}"`);
      }
    }
    this.wires.push({
      id: `w${this.wires.length}`,
      from: { componentId: a, pinId: pa },
      to: { componentId: b, pinId: pb },
      color: "auto",
      routing: "orthogonal",
    });
  }

  build(name: string): CircuitData {
    return { version: 1, name, components: this.comps, wires: this.wires };
  }
}

export interface Preset {
  id: string;
  name: string;
  description: string;
  /** Suggested simulation speed (circuit seconds per real second). */
  speed: number;
  build: () => CircuitData;
}

function ledResistor(): CircuitData {
  const b = new Builder();
  const v = b.add("vdc", 2, 2, { voltage: 5, rint: 0.05 });
  const r = b.add("resistor", 8, 2, { resistance: 330 });
  const d = b.add("led", 14, 2, { color: "red" }, 90);
  const g1 = b.add("ground", 14, 9);
  const g2 = b.add("ground", 2, 9);
  b.wire(v, "p", r, "a");
  b.wire(r, "b", d, "a");
  b.wire(d, "k", g1, "g");
  b.wire(v, "n", g2, "g");
  return b.build("LED + current-limit resistor");
}

function voltageDivider(): CircuitData {
  const b = new Builder();
  const v = b.add("vdc", 2, 2, { voltage: 10, rint: 0.05 });
  const r1 = b.add("resistor", 10, 2, { resistance: 1000 }, 90);
  const r2 = b.add("resistor", 10, 6, { resistance: 3000 }, 90);
  const g1 = b.add("ground", 10, 12);
  const g2 = b.add("ground", 2, 9);
  const m = b.add("dmm", 16, 3, { mode: "voltage" });
  const g3 = b.add("ground", 14, 11);
  b.wire(v, "p", r1, "a");
  b.wire(r1, "b", r2, "a");
  b.wire(r2, "b", g1, "g");
  b.wire(v, "n", g2, "g");
  b.wire(r1, "b", m, "in");
  b.wire(m, "com", g3, "g");
  return b.build("Voltage divider (10 V · 1 k / 3 k)");
}

function rcLowPass(): CircuitData {
  const b = new Builder();
  const s = b.add("sigen", 2, 2, { waveform: "square", amplitude: 2.5, offset: 2.5, frequency: 100, rint: 0 });
  const r = b.add("resistor", 8, 2, { resistance: 1600 });
  const c = b.add("cap_ceramic", 14, 2, { capacitance: 1e-6 }, 90);
  const g1 = b.add("ground", 14, 9);
  const g2 = b.add("ground", 2, 9);
  const sc = b.add("scope", 20, 0, { vdiv1: 1, vdiv2: 1, tdiv: 0.005 });
  const g3 = b.add("ground", 18, 11);
  b.wire(s, "p", r, "a");
  b.wire(r, "b", c, "a");
  b.wire(c, "b", g1, "g");
  b.wire(s, "n", g2, "g");
  b.wire(s, "p", sc, "ch1");
  b.wire(c, "a", sc, "ch2");
  b.wire(sc, "gnd", g3, "g");
  return b.build("RC low-pass filter (fc ≈ 100 Hz)");
}

function ne555Blinker(): CircuitData {
  const b = new Builder();
  const v = b.add("vdc", 2, 2, { voltage: 9, rint: 0.1 });
  const u = b.add("ic555", 12, 6);
  const r1 = b.add("resistor", 26, 2, { resistance: 1000 }, 90);
  const r2 = b.add("resistor", 26, 6, { resistance: 10000 }, 90);
  const c = b.add("cap_electrolytic", 26, 10, { capacitance: 10e-6, voltageRating: 16 }, 90);
  const r3 = b.add("resistor", 4, 11, { resistance: 330 });
  const d = b.add("led", 4, 11, { color: "red" }, 90);
  const gA = b.add("ground", 2, 9);
  const gB = b.add("ground", 26, 16);
  const gC = b.add("ground", 12, 12);
  const gD = b.add("ground", 4, 17);
  // supply
  b.wire(v, "p", u, "p8");
  b.wire(v, "p", u, "p4");
  b.wire(v, "p", r1, "a");
  b.wire(v, "n", gA, "g");
  // timing network
  b.wire(r1, "b", u, "p7");
  b.wire(r1, "b", r2, "a");
  b.wire(r2, "b", u, "p6");
  b.wire(r2, "b", c, "p");
  b.wire(u, "p6", u, "p2");
  b.wire(c, "n", gB, "g");
  b.wire(u, "p1", gC, "g");
  // output stage
  b.wire(u, "p3", r3, "b");
  b.wire(r3, "a", d, "a");
  b.wire(d, "k", gD, "g");
  return b.build("555 astable — blinking LED (≈ 6.9 Hz)");
}

function bridgeRectifier(): CircuitData {
  const b = new Builder();
  const v = b.add("vac", 2, 2, { amplitude: 12, frequency: 50, rint: 0.05 });
  const d1 = b.add("diode", 8, 2);
  const d2 = b.add("diode", 8, 6);
  const d3 = b.add("diode", 8, 10);
  const d4 = b.add("diode", 8, 14);
  const c = b.add("cap_electrolytic", 18, 2, { capacitance: 470e-6, voltageRating: 25 }, 90);
  const r = b.add("resistor", 22, 2, { resistance: 1000 }, 90);
  const g1 = b.add("ground", 18, 9);
  const g2 = b.add("ground", 22, 9);
  const g3 = b.add("ground", 5, 12);
  const sc = b.add("scope", 26, 0, { vdiv1: 5, vdiv2: 5, tdiv: 0.005 });
  const g4 = b.add("ground", 24, 11);
  b.wire(v, "p", d1, "a");
  b.wire(v, "p", d3, "k");
  b.wire(v, "n", d2, "a");
  b.wire(v, "n", d4, "k");
  b.wire(d1, "k", d2, "k");
  b.wire(d3, "a", d4, "a");
  b.wire(d1, "k", c, "p");
  b.wire(c, "p", r, "a");
  b.wire(c, "n", g1, "g");
  b.wire(r, "b", g2, "g");
  b.wire(d3, "a", g3, "g");
  b.wire(d1, "k", sc, "ch1");
  b.wire(v, "p", sc, "ch2");
  b.wire(sc, "gnd", g4, "g");
  return b.build("Bridge rectifier + reservoir capacitor");
}

function bjtAmplifier(): CircuitData {
  const b = new Builder();
  const vcc = b.add("vdc", 2, 2, { voltage: 12, rint: 0.05 });
  const r1 = b.add("resistor", 8, 2, { resistance: 47000 }, 90);
  const r2 = b.add("resistor", 8, 6, { resistance: 10000 }, 90);
  const q = b.add("bjt_npn", 14, 8, { beta: 150 });
  const rc = b.add("resistor", 16, 2, { resistance: 2200 }, 90);
  const re = b.add("resistor", 16, 10, { resistance: 1000 }, 90);
  const ce = b.add("cap_electrolytic", 20, 10, { capacitance: 100e-6, voltageRating: 16 }, 90);
  const cin = b.add("cap_electrolytic", 4, 14, { capacitance: 10e-6, voltageRating: 16 });
  const vin = b.add("sigen", 0, 14, { waveform: "sine", amplitude: 0.02, offset: 0, frequency: 1000, rint: 50 });
  const cout = b.add("cap_electrolytic", 20, 6, { capacitance: 10e-6, voltageRating: 16 });
  const rl = b.add("resistor", 26, 6, { resistance: 10000 }, 90);
  const sc = b.add("scope", 30, 0, { vdiv1: 0.02, vdiv2: 1, tdiv: 0.0005 });
  const gA = b.add("ground", 2, 9);
  const gB = b.add("ground", 8, 12);
  const gC = b.add("ground", 16, 16);
  const gD = b.add("ground", 20, 16);
  const gE = b.add("ground", 26, 12);
  const gF = b.add("ground", 0, 20);
  const gG = b.add("ground", 28, 11);
  b.wire(vcc, "p", r1, "a");
  b.wire(vcc, "p", rc, "a");
  b.wire(vcc, "n", gA, "g");
  b.wire(r1, "b", r2, "a");
  b.wire(r1, "b", q, "b");
  b.wire(r2, "b", gB, "g");
  b.wire(rc, "b", q, "c");
  b.wire(q, "e", re, "a");
  b.wire(re, "b", gC, "g");
  b.wire(q, "e", ce, "p");
  b.wire(ce, "n", gD, "g");
  // input
  b.wire(vin, "p", cin, "n");
  b.wire(cin, "p", q, "b");
  b.wire(vin, "n", gF, "g");
  // output
  b.wire(q, "c", cout, "p");
  b.wire(cout, "n", rl, "a");
  b.wire(rl, "b", gE, "g");
  b.wire(vin, "p", sc, "ch1");
  b.wire(cout, "n", sc, "ch2");
  b.wire(sc, "gnd", gG, "g");
  return b.build("BJT common-emitter amplifier (gain ≈ −100)");
}

const tpl = (id: string): string => templateById(id)?.code ?? "";
const TEMPLATE_POT = tpl("pot");
const TEMPLATE_SERVO = tpl("servo");
const TEMPLATE_SONAR = tpl("sonar");
const TEMPLATE_LCD = tpl("lcd");

// ───────────────────────── Microcontroller presets ─────────────────────────
// Uno placed at (12,2): left pins at x=12, right pins at x=21; pin n of a side sits at y = 2 + row.

/** Series resistor + LED from an Arduino pin to ground, laid out to the right. */
function mcuLed(b: Builder, board: string, pin: string, x: number, y: number, color = "red"): void {
  const r = b.add("resistor", x, y, { resistance: 330 });
  const d = b.add("led", x + 6, y, { color });
  const g = b.add("ground", x + 10, y + 3);
  b.wire(board, pin, r, "a");
  b.wire(r, "b", d, "a");
  b.wire(d, "k", g, "g");
}

function arduinoBlink(): CircuitData {
  const b = new Builder();
  const uno = b.add("arduino_uno", 12, 2, {}, 0, "UNO");
  mcuLed(b, uno, "d13", 24, 16);
  const g = b.add("ground", 21, 21);
  b.wire(uno, "gnd3", g, "g");
  return b.build("Arduino Uno — LED Blink");
}

function arduinoButton(): CircuitData {
  const b = new Builder();
  const uno = b.add("arduino_uno", 12, 2, {}, 0, "UNO");
  mcuLed(b, uno, "d13", 24, 16);
  const btn = b.add("pushbutton", 24, 5);
  const gb = b.add("ground", 28, 8);
  b.wire(uno, "d2", btn, "a");
  b.wire(btn, "b", gb, "g");
  const g = b.add("ground", 21, 21);
  b.wire(uno, "gnd3", g, "g");
  return b.build("Arduino Uno — Button to LED");
}

const FADE_SKETCH = `int led = 9;
int brightness = 0;
int step = 5;

void setup() {
  pinMode(led, OUTPUT);
}

void loop() {
  analogWrite(led, brightness);
  brightness += step;
  if (brightness <= 0 || brightness >= 255) step = -step;
  delay(20);
}
`;

function arduinoFade(): CircuitData {
  const b = new Builder();
  const uno = b.add("arduino_uno", 12, 2, { code: FADE_SKETCH }, 0, "UNO");
  mcuLed(b, uno, "d9", 24, 12, "green");
  const g = b.add("ground", 21, 21);
  b.wire(uno, "gnd3", g, "g");
  return b.build("Arduino Uno — PWM fade");
}

function arduinoPot(): CircuitData {
  const b = new Builder();
  const code = TEMPLATE_POT;
  const uno = b.add("arduino_uno", 12, 2, { code }, 0, "UNO");
  const pot = b.add("potentiometer", 2, 9, { resistance: 10000, wiper: 30 });
  const g1 = b.add("ground", 6, 13);
  b.wire(uno, "5v", pot, "a");
  b.wire(pot, "b", g1, "g");
  b.wire(pot, "w", uno, "a0");
  mcuLed(b, uno, "d9", 24, 12, "yellow");
  const g = b.add("ground", 21, 21);
  b.wire(uno, "gnd3", g, "g");
  return b.build("Arduino Uno — Pot dims LED + serial");
}

function arduinoServo(): CircuitData {
  const b = new Builder();
  const uno = b.add("arduino_uno", 12, 2, { code: TEMPLATE_SERVO }, 0, "UNO");
  const sv = b.add("servo", 26, 6, { angle: 90 });
  const bat = b.add("vdc", 24, 14, { voltage: 5, rint: 0.05 });
  const gs = b.add("ground", 24, 20);
  b.wire(uno, "d9", sv, "sig");
  b.wire(bat, "p", sv, "vcc");
  b.wire(bat, "n", gs, "g");
  b.wire(sv, "gnd", gs, "g");
  const g = b.add("ground", 21, 21);
  b.wire(uno, "gnd3", g, "g");
  return b.build("Arduino Uno — Servo sweep");
}

function arduinoSonar(): CircuitData {
  const b = new Builder();
  const uno = b.add("arduino_uno", 12, 2, { code: TEMPLATE_SONAR }, 0, "UNO");
  const hc = b.add("hcsr04", 26, 2, { distanceCm: 80 });
  const bat = b.add("vdc", 36, 2, { voltage: 5, rint: 0.05 });
  const gs = b.add("ground", 36, 8);
  b.wire(uno, "d7", hc, "trig");
  b.wire(uno, "d8", hc, "echo");
  b.wire(bat, "p", hc, "vcc");
  b.wire(bat, "n", gs, "g");
  b.wire(hc, "gnd", gs, "g");
  const g = b.add("ground", 21, 21);
  b.wire(uno, "gnd3", g, "g");
  return b.build("Arduino Uno — HC-SR04 distance");
}

function arduinoLcd(): CircuitData {
  const b = new Builder();
  const uno = b.add("arduino_uno", 12, 2, { code: TEMPLATE_LCD }, 0, "UNO");
  const lcd = b.add("lcd1602", 26, 2);
  const g = b.add("ground", 21, 21);
  const gl = b.add("ground", 24, 14);
  b.wire(uno, "gnd3", g, "g");
  b.wire(uno, "d12", lcd, "rs");
  b.wire(uno, "d11", lcd, "e");
  b.wire(uno, "d5", lcd, "d4");
  b.wire(uno, "d4", lcd, "d5");
  b.wire(uno, "d3", lcd, "d6");
  b.wire(uno, "d2", lcd, "d7");
  b.wire(lcd, "vss", gl, "g");
  b.wire(lcd, "rw", gl, "g");
  b.wire(lcd, "v0", gl, "g");
  b.wire(lcd, "k", gl, "g");
  b.wire(lcd, "vdd", uno, "5v");
  b.wire(lcd, "a", uno, "5v");
  return b.build("Arduino Uno — LCD 16x2 (4-bit)");
}

function esp32Blink(): CircuitData {
  const b = new Builder();
  const esp = b.add("esp32", 2, 2, {}, 0, "ESP32");
  mcuLed(b, esp, "r_g2", 14, 16, "blue");
  const g = b.add("ground", 11, 19);
  b.wire(esp, "r_gnd", g, "g");
  return b.build("ESP32 — LED Blink");
}

function attinyBlink(): CircuitData {
  const b = new Builder();
  const t = b.add("attiny85", 2, 2, {}, 0, "ATtiny");
  const bat = b.add("vdc", 14, 8, { voltage: 5, rint: 0.05 });
  const gb = b.add("ground", 14, 14);
  const g4 = b.add("ground", 2, 9);
  b.wire(t, "p8", bat, "p");
  b.wire(bat, "n", gb, "g");
  b.wire(t, "p4", g4, "g");
  const r = b.add("resistor", 14, 5, { resistance: 330 });
  const d = b.add("led", 20, 5, { color: "red" });
  const gl = b.add("ground", 24, 8);
  b.wire(t, "p6", r, "a");
  b.wire(r, "b", d, "a");
  b.wire(d, "k", gl, "g");
  return b.build("ATtiny85 — LED Blink (PB1)");
}

export const PRESETS: Preset[] = [
  { id: "led", speed: 1, name: "LED + Resistor", description: "5 V → 330 Ω → red LED. Try a smaller resistor to watch it burn.", build: ledResistor },
  { id: "divider", speed: 1, name: "Voltage Divider", description: "10 V across 1 kΩ / 3 kΩ with a multimeter reading 7.5 V.", build: voltageDivider },
  { id: "rc", speed: 0.05, name: "RC Low-Pass Filter", description: "100 Hz square wave through 1.6 kΩ + 1 µF; watch CH2 round off.", build: rcLowPass },
  { id: "555", speed: 1, name: "555 Blinking LED", description: "Astable 555 timer driving an LED at about 7 Hz.", build: ne555Blinker },
  { id: "bridge", speed: 0.05, name: "Bridge Rectifier", description: "12 V AC full-wave rectified into a 470 µF reservoir.", build: bridgeRectifier },
  { id: "bjt", speed: 0.01, name: "BJT Amplifier", description: "Common-emitter stage with voltage-divider bias and bypassed emitter.", build: bjtAmplifier },
  { id: "uno-blink", speed: 1, name: "Arduino · LED Blink", description: "Uno running a Blink sketch on D13 — edit the code in the Code tab.", build: arduinoBlink },
  { id: "uno-button", speed: 1, name: "Arduino · Button → LED", description: "INPUT_PULLUP button on D2; click it while running.", build: arduinoButton },
  { id: "uno-fade", speed: 1, name: "Arduino · PWM fade", description: "analogWrite fading an LED on D9 (watch the scope-less glow).", build: arduinoFade },
  { id: "uno-pot", speed: 1, name: "Arduino · Pot + Serial", description: "analogRead from a potentiometer dims the LED and prints to the Serial monitor.", build: arduinoPot },
  { id: "uno-servo", speed: 1, name: "Arduino · Servo sweep", description: "Servo library sweeping a servo 0–180° on D9, externally powered.", build: arduinoServo },
  { id: "uno-sonar", speed: 1, name: "Arduino · HC-SR04", description: "pulseIn distance measurement; change the distance in the sensor Inspector.", build: arduinoSonar },
  { id: "uno-lcd", speed: 1, name: "Arduino · LCD 16×2", description: "LiquidCrystal in 4-bit mode with a simulated HD44780.", build: arduinoLcd },
  { id: "esp32-blink", speed: 1, name: "ESP32 · LED Blink", description: "ESP32 DevKit blinking GPIO2 (3.3 V logic).", build: esp32Blink },
  { id: "attiny-blink", speed: 1, name: "ATtiny85 · LED Blink", description: "ATtiny85 on a 5 V supply blinking PB1.", build: attinyBlink },
];
