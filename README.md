# CircuitLab

Interactive electronics simulator: Next.js 15 (App Router, strict TypeScript), Tailwind, Zustand, HTML5 Canvas.

```bash
npm install
npm run dev          # http://localhost:3000
npm run typecheck
npm run selftest     # ~170 checks (solver, AC, scope, generators, transformers, Arduino compiler, MCU-in-circuit, presets)
npm run build
```

## Layout

| Path | Responsibility |
| --- | --- |
| `src/models` | Domain types, the 60-part catalog, geometry/routing, units, resistor colour code |
| `src/engine` | Netlist (union-find), dense MNA stamper, device models, transient simulator, runtime singletons |
| `src/store` | Zustand: circuit + undo/redo, viewport, UI, simulation controls |
| `src/ui/canvas` | Canvas renderer, schematic + physical symbols, interaction (pan/zoom/drag/wire) |
| `src/ui/panels` | Library, inspector, toolbar, bottom dock (instruments / code editor / serial monitor), colour-code calculator |
| `src/mcu` | Arduino-C++ subset compiler (lexer → parser → JS generators), board specs, MCU runtime (virtual time, PWM, ADC, Serial, Servo, LiquidCrystal, interrupts) |
| `src/storage` | JSON (validated import), PNG, printable SVG (own canvas→SVG recorder) |
| `src/presets` | Example circuits, wired by pin name (invalid pins throw) |

## Engine

* Modified Nodal Analysis, θ-method (θ = 0.55, near-trapezoidal) companion models for C and L, Newton–Raphson for
  nonlinear parts (SPICE `pnjlim` limiting on junctions, step limiting + gain homotopy on behavioural blocks).
* Variable step: the runner shrinks the step for AC sources and stretches it at high speed.
* Overload model: each part reports `stress` (fraction of its rating); sustained stress > 1 accumulates
  heat and destroys the part (resistor power, LED current, capacitor voltage/reverse polarity,
  transistor Ic/P, regulator current/dissipation …). Tantalum fails short, others open.
* Wire currents are distributed over a spanning tree of each net so every wire animates its own flow.

## Simulated

Resistor, LDR, NTC/PTC, potentiometer/trimmer, capacitors, inductor, DC/AC/signal sources (bench supplies
have a smooth constant-current limit), batteries, diodes (rectifier/Zener/Schottky/LED), RGB LED, 7-segment,
BJT NPN/PNP, JFET, MOSFET N/P, SCR, triac, optocoupler, transformer (coupled windings, optional centre tap, core loss), UA741/LM358,
78xx/79xx/LM317, 7400-series gates, 555, relay, switches/DIP/push button, buzzer, DC motor, servo,
HC-SR04, LCD 16×2 (HD44780 4/8-bit protocol decoder), multimeter (DC and true-RMS AC), 2-channel scope (see below),
8-channel logic analyser, and **microcontrollers** (Arduino Uno, ESP32 DevKit, ATtiny85).

## AC, generators and the oscilloscope

* **AC source / function generator**: sine, square (duty), triangle, sawtooth; amplitude as peak, RMS or peak-to-peak;
  phase, DC offset and output resistance. The step is capped so each period has at least 100 samples and source
  corners are hit exactly, so waveforms are not rounded off.
* **Transformer**: coupled windings solved as MNA branch currents (V = R·i + L·di/dt with mutual inductance),
  centre-tap variant (two series-aiding half secondaries), core loss; the Inspector shows RMS voltages/currents,
  power in/out and efficiency.
* **Multimeter**: DC, true-RMS AC voltage and AC current.
* **Oscilloscope** (dock + on-canvas symbol share one renderer): min/max envelope sampling (no aliasing at slow
  time bases), Y-T and X-Y, triggering on CH1/CH2 (rising/falling, auto/normal, auto or manual level, hysteresis,
  10 % pre-trigger), DC/AC/GND coupling, vertical position, 1-2-5 V/div and time/div ladders, CH1±CH2 / CH1×CH2 math,
  Vpp/mean/RMS/frequency/period read-outs, hover cursors, STOP, AUTO set and PNG export.
* **AC presets**: 230 V mains supply with regulator, centre-tap full-wave rectifier, step-down transformer with
  AC voltmeter, series RLC resonance, RC phase shift in X-Y, voltage doubler, zener clipper.

## Microcontrollers

Open a board, press **Edit code** in the Inspector (or the *Code* tab). Sketches are written in a
practical Arduino-C++ subset and compiled to JavaScript generators that run in virtual time:

* `setup/loop`, functions, globals, `#define`/`#if`/`#include`, enums/typedefs, arrays, `String`, `float`,
  fixed-width integer semantics per board (16-bit on AVR, 32-bit on ESP32), `printf`-style helpers.
* `pinMode/digitalRead/digitalWrite/analogRead/analogWrite/tone/pulseIn/shiftOut/attachInterrupt`, `millis/micros/delay`,
  `Serial` (monitor tab, input box), `Servo`, `LiquidCrystal`.
* Not supported (clear compile error): structs/classes, pointers/references, `goto`, `Wire`/`SPI`/`EEPROM`.
* GPIO drivers are Thevenin sources (25–30 Ω): shorting an output or overdriving a pin burns the board.

The editor is Monaco loaded from a CDN; if it cannot be fetched a plain text area is used automatically.

## Shortcuts

`V/W` select/wire · `R/F` rotate/flip · `Del` delete · `Ctrl+Z/Y` undo/redo · `Ctrl+C/X/V/D` copy/cut/paste/duplicate ·
arrows nudge (Shift ×5) · `Ctrl+S` export JSON · the circuit is autosaved to the browser.

## Next

1. Obstacle-aware wire routing and wire waypoints.
2. Wire/SPI/EEPROM libraries and structs/classes in the sketch compiler.
3. Split `engine/devices.ts` further.
