# CircuitLab

Interactive electronics simulator: Next.js 15 (App Router, strict TypeScript), Tailwind, Zustand, HTML5 Canvas.

```bash
npm install
npm run dev          # http://localhost:3000
npm run typecheck
npm run selftest     # 45 numerical checks of the solver, device models and presets
npm run build
```

## Layout

| Path | Responsibility |
| --- | --- |
| `src/models` | Domain types, the 60-part catalog, geometry/routing, units, resistor colour code |
| `src/engine` | Netlist (union-find), dense MNA stamper, device models, transient simulator, runtime singletons |
| `src/store` | Zustand: circuit + undo/redo, viewport, UI, simulation controls |
| `src/ui/canvas` | Canvas renderer, schematic + physical symbols, interaction (pan/zoom/drag/wire) |
| `src/ui/panels` | Library, inspector, toolbar, scope, status bar, colour-code calculator |
| `src/storage` | JSON (validated import), PNG, printable SVG (own canvas→SVG recorder) |
| `src/presets` | Example circuits, wired by pin name (invalid pins throw) |

## Engine

* Modified Nodal Analysis, backward-Euler companion models for C and L, Newton–Raphson for
  nonlinear parts (SPICE `pnjlim` limiting on junctions, step limiting + gain homotopy on behavioural blocks).
* Variable step: the runner shrinks the step for AC sources and stretches it at high speed.
* Overload model: each part reports `stress` (fraction of its rating); sustained stress > 1 accumulates
  heat and destroys the part (resistor power, LED current, capacitor voltage/reverse polarity,
  transistor Ic/P, regulator current/dissipation …). Tantalum fails short, others open.
* Wire currents are distributed over a spanning tree of each net so every wire animates its own flow.

## Simulated vs. visual only

Simulated: resistor, LDR, NTC/PTC, potentiometer/trimmer, capacitors, inductor, DC/AC/signal sources,
batteries, diodes (rectifier/Zener/Schottky/LED), RGB LED, 7-segment, BJT NPN/PNP, MOSFET N/P,
UA741/LM358, 78xx/79xx/LM317, 7400-series gates, 555, relay, switches/DIP/push button, buzzer, DC motor,
multimeter (V/A/Ω), 2-channel scope, 8-channel logic analyser.

Drawn and wireable but **not** electrically modelled yet: transformer, JFET, SCR, triac, optocoupler,
HC-SR04, LCD 16×2, servo, microcontrollers (Arduino Uno, ESP32, ATtiny85).

## Next

1. Monaco editor + sketch interpreter driving MCU GPIO (Arduino LED-blink preset).
2. Models for transformer, JFET, SCR/triac, optocoupler.
3. Obstacle-aware wire routing and wire waypoints.
