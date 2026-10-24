/**
 * Educational notes for every catalog part: what it does, the equations that describe it and where it is used.
 * Shown in the library hover card, the canvas hover card and the Inspector's "About this part" section.
 */

export interface HelpTable {
  head: string[];
  rows: string[][];
}

export interface ComponentHelp {
  /** one-line definition */
  what: string;
  /** how it behaves */
  how: string;
  /** standard formulas / laws, one per line */
  formulas: string[];
  /** practical use cases */
  uses: string[];
  /** extra advice, pitfalls, how to wire it in this simulator */
  tip?: string;
  /** truth table / state table */
  table?: HelpTable;
}

const T2 = (fn: (a: number, b: number) => number): HelpTable => ({
  head: ["A", "B", "Y"],
  rows: [0, 1].flatMap((a) => [0, 1].map((b) => [String(a), String(b), String(fn(a, b))])),
});

const gate = (name: string, expr: string, table: HelpTable, uses: string[], what: string): ComponentHelp => ({
  what,
  how: `A digital ${name} gate: inputs above about half the supply are read as logic 1, below as logic 0. The output is driven hard to the supply or to GND through a small output resistance. Unconnected inputs float and give undefined results, so tie them to 0 or 1.`,
  formulas: [`Y = ${expr}`],
  uses,
  tip: "Power it: connect the supply and GND pins (set via the Supply parameter). Gates can be chained to build any digital circuit.",
  table,
});

export const HELP: Record<string, ComponentHelp> = {
  resistor: {
    what: "Opposes the flow of current, converting electrical energy into heat.",
    how: "The voltage across an ideal resistor is proportional to the current through it. It has no polarity. Its power rating is how much heat it can shed: exceed it for long enough and it burns.",
    formulas: ["V = I · R   (Ohm's law)", "P = V · I = I² · R = V² / R", "Series: R = R1 + R2 …      Parallel: 1/R = 1/R1 + 1/R2 …", "Divider: Vout = Vin · R2 / (R1 + R2)"],
    uses: ["Limit the current through an LED or transistor base", "Voltage dividers and pull-up / pull-down resistors", "Set gain, time constants (with a capacitor) and bias points"],
    tip: "Use the colour-code calculator in the Inspector to read bands. Pick the power rating ≥ 2 × the calculated dissipation.",
  },
  cap_ceramic: {
    what: "Stores energy in an electric field; non-polarised, small values, excellent at high frequency.",
    how: "Current is proportional to how fast the voltage changes, so it blocks DC and passes AC. Voltage across it can never jump instantly.",
    formulas: ["I = C · dV/dt", "Q = C · V      E = ½ · C · V²", "Reactance: Xc = 1 / (2π f C)", "RC time constant: τ = R · C  (charges to 63 % in 1 τ)"],
    uses: ["Decoupling next to ICs", "High-pass / low-pass RC filters", "Timing with a resistor, AC coupling"],
    tip: "Ceramic capacitors have no polarity, so they can be connected either way round.",
  },
  cap_electrolytic: {
    what: "High-capacitance polarised capacitor for power-supply smoothing.",
    how: "Behaves like a capacitor but the + terminal must stay at a higher voltage than −. A reverse voltage above ~1.5 V or exceeding the voltage rating destroys it.",
    formulas: ["I = C · dV/dt", "E = ½ · C · V²", "Ripple on a rectified supply: ΔV ≈ I / (f · C)  (f = 100 Hz for 50 Hz full-wave)", "τ = R · C"],
    uses: ["Smoothing rectified AC (reservoir capacitor)", "Bulk decoupling on supply rails", "Audio coupling and energy storage"],
    tip: "Choose a voltage rating of at least 1.5 × the highest voltage it will see.",
  },
  cap_tantalum: {
    what: "Compact polarised capacitor with stable value and low leakage.",
    how: "Like an electrolytic, but over-voltage or reverse polarity makes it fail short-circuit (and in real life it can burn), so respect polarity and derate the voltage.",
    formulas: ["I = C · dV/dt", "E = ½ · C · V²", "Xc = 1 / (2π f C)"],
    uses: ["Small-size decoupling and filtering", "Timing circuits needing stable capacitance"],
    tip: "Never apply reverse voltage. Derate to 50 % of the rated voltage in real designs.",
  },
  inductor: {
    what: "Stores energy in a magnetic field; opposes changes in current.",
    how: "The voltage across it is proportional to how fast the current changes. At DC it is only its winding resistance, so it passes DC and resists AC. Current cannot change instantly, so switching it off produces a voltage spike.",
    formulas: ["V = L · dI/dt", "E = ½ · L · I²", "Reactance: XL = 2π f L", "RL time constant: τ = L / R", "Resonance with C: f0 = 1 / (2π √(L·C))"],
    uses: ["Filters and LC resonant circuits", "Switching regulators (buck / boost)", "Chokes that block noise"],
    tip: "At DC the only limit is the winding resistance (DCR): a bare inductor across a supply draws a very large current.",
  },
  transformer: {
    what: "Two magnetically coupled windings that change an AC voltage level and isolate the circuits.",
    how: "AC in the primary creates a changing magnetic flux that induces a voltage in the secondary in proportion to the turns ratio. It does nothing for DC. The simulator solves both windings with mutual inductance, winding resistance and core loss.",
    formulas: ["Vs / Vp = Ns / Np = n", "Is / Ip = Np / Ns = 1 / n   (ideal)", "P_in ≈ P_out (efficiency = P_out / P_in)", "Reflected load: Z_primary = Z_load / n²"],
    uses: ["Step mains (230 V) down to a safe low voltage", "Galvanic isolation", "Impedance matching"],
    tip: "Read RMS voltages, currents and efficiency in the Inspector while running. Use an AC source — a DC source gives no secondary voltage.",
  },
  transformer_ct: {
    what: "Transformer whose secondary has a centre tap (two equal halves).",
    how: "The centre tap is the midpoint of the secondary. Each half gives half the total voltage; with the tap grounded the two outer ends swing in opposite phase.",
    formulas: ["Each half: V = Vs / 2", "Full secondary: Vs = n · Vp", "Full-wave rectifier peak: Vdc ≈ Vs/2 · √2 − Vf"],
    uses: ["Full-wave rectifiers with only two diodes", "Split (±) supplies", "Push-pull amplifiers"],
    tip: "Ground the centre tap (pin CT) and put a diode on each outer end for a full-wave rectifier.",
  },
  potentiometer: {
    what: "Variable resistor with three terminals: two ends and a sliding wiper.",
    how: "The track resistance is fixed between the ends; the wiper taps off any fraction of it. Used as a voltage divider it gives an adjustable voltage; with two terminals it is a variable resistor.",
    formulas: ["R_AW = R · (1 − w),   R_WB = R · w     (w = wiper position 0…1)", "Vwiper = Vin · w   (unloaded divider)"],
    uses: ["Volume and brightness controls", "Analog input to a microcontroller", "Adjusting a reference or gain"],
    tip: "A heavy load on the wiper distorts the divider ratio: keep the load much larger than the pot.",
  },
  trimmer: {
    what: "Small preset potentiometer adjusted once with a screwdriver.",
    how: "Identical to a potentiometer electrically; used for calibration rather than everyday control.",
    formulas: ["R_AW = R · (1 − w),   R_WB = R · w", "Vwiper = Vin · w"],
    uses: ["Calibrating offsets and thresholds", "Setting a bias point once"],
  },
  diode: {
    what: "One-way valve for current (silicon rectifier diode).",
    how: "Conducts when the anode is more positive than the cathode by about 0.7 V (forward drop) and blocks in reverse. The forward current rises exponentially with voltage.",
    formulas: ["I = Is · (e^(V / (n·Vt)) − 1)", "Vt ≈ 25.9 mV at 300 K", "Forward drop Vf ≈ 0.6 – 0.7 V (silicon)"],
    uses: ["Rectifying AC to DC", "Reverse-polarity protection", "Flyback (freewheel) diode across inductive loads"],
    tip: "Current flows from the anode (triangle base) to the cathode (bar). Add a series resistor to limit current.",
  },
  zener: {
    what: "Diode designed to conduct in reverse at a precise breakdown voltage.",
    how: "Forward it behaves like a normal diode. In reverse it blocks until the voltage reaches Vz, then conducts and holds the voltage nearly constant.",
    formulas: ["Series resistor: R = (Vin − Vz) / (I_Z + I_load)", "P_zener = Vz · I_Z (must stay below the power rating)"],
    uses: ["Simple voltage reference / shunt regulator", "Clipping and over-voltage protection"],
    tip: "Always use a series resistor, otherwise the zener burns. Connect the cathode to the positive side.",
  },
  schottky: {
    what: "Diode with a low forward drop (≈ 0.3 V) and very fast switching.",
    how: "Made from a metal–semiconductor junction. It wastes less power than a silicon diode but has higher leakage in reverse.",
    formulas: ["I = Is · (e^(V / (n·Vt)) − 1)", "Vf ≈ 0.2 – 0.4 V", "P_loss = Vf · I"],
    uses: ["Switching power supplies and rectifiers", "Low-voltage reverse-polarity protection", "Fast clamping"],
  },
  led: {
    what: "Light-emitting diode: glows when current flows forward.",
    how: "Conducts above its forward voltage (red ≈ 1.8 V, green ≈ 2.2 V, blue/white ≈ 3 V). Brightness follows the current, not the voltage, and the current rises extremely steeply, so it must be limited.",
    formulas: ["R = (Vsupply − Vf) / I_LED", "Typical I_LED = 5 – 20 mA", "P_R = (Vsupply − Vf) · I_LED"],
    uses: ["Indicators and displays", "Optocoupler inputs", "Lighting"],
    tip: "An LED connected straight to a supply burns instantly. Always place a series resistor (e.g. 330 Ω at 5 V).",
  },
  bjt_npn: {
    what: "Bipolar transistor: a small base current controls a much larger collector current.",
    how: "With Vbe ≈ 0.7 V the transistor turns on. In the active region Ic = β · Ib; in saturation (switch fully on) Vce drops to ≈ 0.2 V. Off when Vbe < 0.6 V.",
    formulas: ["Ic = β · Ib", "Ie = Ic + Ib", "Switch: Rb ≈ (Vin − 0.7 V) · β / (5 · Ic)   (≈ 5× overdrive to saturate)", "P = Vce · Ic"],
    uses: ["Switching LEDs, relays and motors", "Amplifiers", "Current sources and logic"],
    tip: "NPN: emitter to the lower voltage (GND), load between the supply and the collector. Never connect the base straight to a supply.",
  },
  bjt_pnp: {
    what: "PNP bipolar transistor: the complement of NPN, conducts when the base is pulled below the emitter.",
    how: "Current flows from the emitter to the collector when the base is about 0.7 V below the emitter. Used as a high-side switch.",
    formulas: ["Ic = β · Ib", "Veb ≈ 0.7 V to turn on", "P = Vec · Ic"],
    uses: ["High-side switches", "Complementary push-pull stages", "Current mirrors"],
    tip: "Emitter to the positive supply; pull the base low (through a resistor) to switch on.",
  },
  nmos: {
    what: "N-channel MOSFET: a voltage-controlled switch/amplifier (no gate current).",
    how: "Conducts between drain and source when Vgs exceeds the threshold Vth. Below it the transistor is off; above it the channel behaves as a variable resistor (triode) or a current source (saturation).",
    formulas: ["Saturation: Id = ½ · k · (Vgs − Vth)²", "Triode: Id = k · ((Vgs − Vth)·Vds − Vds²/2)", "P = Id · Vds"],
    uses: ["Low-loss switching of motors and loads", "Switching power supplies", "Logic and amplifiers"],
    tip: "Source to GND, load between the supply and the drain. Drive the gate well above Vth so it is fully on.",
  },
  pmos: {
    what: "P-channel MOSFET: conducts when the gate is pulled below the source.",
    how: "Switches when Vgs is more negative than −Vth. Ideal as a high-side switch since its source sits at the positive rail.",
    formulas: ["Id = ½ · k · (Vsg − |Vth|)²  (saturation)", "P = Id · Vds"],
    uses: ["High-side load switches", "Reverse-polarity protection", "Complementary switching stages"],
  },
  jfet_n: {
    what: "N-channel junction FET: a normally-on channel pinched off by a negative gate voltage.",
    how: "With Vgs = 0 it conducts Idss. Making the gate negative towards the pinch-off voltage Vp reduces the current to zero. The gate junction must stay reverse-biased.",
    formulas: ["Id = Idss · (1 − Vgs / Vp)²", "gm = 2 · Idss / |Vp| · (1 − Vgs / Vp)"],
    uses: ["High-impedance amplifier front ends", "Voltage-controlled resistors", "Analog switches"],
  },
  scr: {
    what: "Thyristor (SCR): a latching switch triggered by a gate pulse.",
    how: "Blocks in both directions until a small gate current turns it on (when anode is positive). It then stays on, even after the gate current is removed, until the anode current drops below the holding current.",
    formulas: ["Turn on: I_gate ≥ I_GT with V_AK > 0", "Turn off: I_A < I_H (holding current)", "On-state drop ≈ 1 V"],
    uses: ["Controlled rectifiers and phase control", "Crowbar over-voltage protection", "Latching alarms"],
    tip: "In AC circuits it switches off by itself at every zero crossing.",
  },
  triac: {
    what: "Bidirectional thyristor for switching AC power.",
    how: "Like two SCRs in anti-parallel: a gate pulse of either polarity lets it conduct in either direction until the current falls below the holding current (the next zero crossing).",
    formulas: ["Conducts when |I_G| ≥ I_GT and |V_MT2-MT1| > ~1 V", "Turns off when I < I_H", "Power controlled by firing angle α"],
    uses: ["Light dimmers and motor speed control", "Mains switching (with an opto-isolated driver)"],
  },
  optocoupler: {
    what: "LED and phototransistor in one package: transfers a signal with galvanic isolation.",
    how: "Current in the input LED lights it, and the light switches on the output phototransistor. The ratio of output to input current is the CTR.",
    formulas: ["I_C = CTR · I_F", "R_LED = (V − Vf) / I_F"],
    uses: ["Isolating a microcontroller from mains or high voltage", "Noise-immune signal links", "Isolated feedback in power supplies"],
    tip: "Limit the input LED current with a series resistor, and pull the output up with a resistor.",
  },
  ic555: {
    what: "Classic timer IC used as an oscillator or one-shot.",
    how: "Two comparators and a flip-flop. The output goes high when TRIG falls below ⅓ Vcc and low when THR exceeds ⅔ Vcc. In astable mode an RC network charges and discharges between those thresholds.",
    formulas: ["Astable: f = 1.44 / ((R1 + 2·R2) · C)", "High time: t_H = 0.693 · (R1 + R2) · C", "Low time: t_L = 0.693 · R2 · C", "Monostable: t = 1.1 · R · C"],
    uses: ["Blinkers and tone generators", "Pulse stretching and delays", "PWM dimming"],
    tip: "Supply 4.5 – 16 V. Pin 4 (RESET) must be high to run; connect it to Vcc.",
  },
  ua741: {
    what: "General-purpose operational amplifier.",
    how: "Amplifies the difference between its inputs by a very large gain. With negative feedback the output makes the two inputs equal, so the circuit gain is set by external resistors. Output is limited to a bit below the supply rails.",
    formulas: ["Vout = A · (V+ − V−)", "Inverting: Vout = −(Rf / Rin) · Vin", "Non-inverting: Vout = (1 + Rf / Rg) · Vin", "Comparator (no feedback): Vout = ±Vsat"],
    uses: ["Amplifiers and active filters", "Comparators", "Integrators, summers and buffers"],
    tip: "Needs a dual supply (e.g. ±12 V) or a single supply with a bias. Always use feedback for linear operation.",
  },
  lm358: {
    what: "Dual op-amp that works from a single supply and swings close to ground.",
    how: "Works like any op-amp but its input and output reach near 0 V, so it suits single-supply 5 V circuits.",
    formulas: ["Vout = A · (V+ − V−)", "Non-inverting: Vout = (1 + Rf / Rg) · Vin", "Inverting: Vout = −(Rf / Rin) · Vin"],
    uses: ["Single-supply amplifiers and buffers", "Sensor conditioning", "Comparators"],
  },
  reg7805: {
    what: "Linear regulator giving a fixed +5 V from a higher input voltage.",
    how: "Holds the output at 5 V while the input stays above output + dropout (≈ 2 V). The surplus voltage is burned as heat.",
    formulas: ["Vout = 5 V   (Vin ≥ 7 V)", "P_heat = (Vin − Vout) · Iout", "Efficiency ≈ Vout / Vin"],
    uses: ["Powering logic and microcontrollers from a 9 – 12 V source", "Clean supply after a rectifier"],
    tip: "Add a capacitor on the input and output. Large (Vin − Vout) × I makes it overheat.",
  },
  reg7812: {
    what: "Linear regulator giving a fixed +12 V.",
    how: "Same principle as the 7805 with a 12 V output. Needs the input at least ~2 V above the output.",
    formulas: ["Vout = 12 V   (Vin ≥ 14.5 V)", "P_heat = (Vin − 12) · Iout"],
    uses: ["12 V rails for op-amps, relays and fans"],
  },
  reg7905: {
    what: "Negative linear regulator giving −5 V.",
    how: "Regulates a negative input to −5 V. The input must be at least ~2 V more negative than the output.",
    formulas: ["Vout = −5 V   (Vin ≤ −7 V)", "P_heat = |Vin − Vout| · Iout"],
    uses: ["Negative rail for dual-supply op-amp circuits (with a 7805)"],
  },
  lm317: {
    what: "Adjustable linear regulator (1.25 – 37 V).",
    how: "Keeps 1.25 V between OUT and ADJ. A resistor divider from the output sets the output voltage.",
    formulas: ["Vout = 1.25 · (1 + R2 / R1) + I_adj · R2", "I_adj ≈ 50 µA (negligible)", "P_heat = (Vin − Vout) · Iout"],
    uses: ["Adjustable bench supplies", "Constant-current sources"],
    tip: "R1 (~240 Ω) goes between OUT and ADJ; R2 between ADJ and GND.",
  },
  gate_and: gate("AND", "A · B", T2((a, b) => a & b), ["Enabling signals", "Combining conditions (both must be true)"], "Output is 1 only when all inputs are 1."),
  gate_or: gate("OR", "A + B", T2((a, b) => a | b), ["Alarm inputs (any sensor triggers)", "Merging signals"], "Output is 1 when at least one input is 1."),
  gate_not: {
    what: "Inverter: the output is the opposite of the input.",
    how: "A digital NOT gate flips the logic level. Two inverters in a ring make an oscillator.",
    formulas: ["Y = ¬A"],
    uses: ["Signal inversion", "Buffers and oscillators"],
    tip: "Power it: connect the supply and GND pins.",
    table: { head: ["A", "Y"], rows: [["0", "1"], ["1", "0"]] },
  },
  gate_nand: gate("NAND", "¬(A · B)", T2((a, b) => 1 - (a & b)), ["Universal gate: any logic can be built from NANDs", "Latches and flip-flops"], "Output is 0 only when all inputs are 1."),
  gate_nor: gate("NOR", "¬(A + B)", T2((a, b) => 1 - (a | b)), ["Universal gate", "SR latches"], "Output is 1 only when all inputs are 0."),
  gate_xor: gate("XOR", "A ⊕ B", T2((a, b) => a ^ b), ["Half adders (sum bit)", "Parity checks and comparators"], "Output is 1 when the inputs differ."),
  arduino_uno: {
    what: "ATmega328P microcontroller board (5 V, 16 MHz).",
    how: "Runs your sketch (setup / loop). Digital pins read or drive 0/5 V, analog pins read 0–5 V with a 10-bit ADC, PWM pins fake analog outputs. Each pin can source/sink only ~20–40 mA.",
    formulas: ["analogRead: value = Vin / 5 V · 1023", "PWM average: V = duty · 5 V", "R_LED = (5 − Vf) / 0.015"],
    uses: ["Blinking LEDs, reading sensors, driving servos", "Serial communication and displays"],
    tip: "Select the board and press “Edit code” in the Inspector. Never connect a pin directly to a heavy load.",
  },
  esp32: {
    what: "ESP32 DevKit: 3.3 V dual-core microcontroller with Wi-Fi/Bluetooth.",
    how: "Same programming model as Arduino but at 3.3 V logic, 12-bit ADC and many GPIOs. Pins must never see more than ~3.3 V.",
    formulas: ["analogRead: value = Vin / 3.3 V · 4095", "R_LED = (3.3 − Vf) / 0.01"],
    uses: ["IoT projects", "Fast sensor reading and PWM"],
    tip: "It is 3.3 V logic: use a divider or level shifter for 5 V signals.",
  },
  attiny85: {
    what: "Tiny 8-pin AVR microcontroller.",
    how: "Five usable I/O pins, 10-bit ADC and PWM. Runs the same C++ subset sketches as the Uno.",
    formulas: ["analogRead: value = Vin / Vcc · 1023"],
    uses: ["Small single-purpose gadgets", "Cheap LED effects"],
  },
  ground: {
    what: "Reference point (0 V) of the circuit.",
    how: "All voltages are measured relative to ground. Every circuit needs one; without it the first source's negative terminal is used.",
    formulas: ["V_GND = 0 V"],
    uses: ["Common return path for all parts"],
  },
  vdc: {
    what: "Adjustable DC bench supply with current limiting.",
    how: "Provides a constant voltage until the load asks for more than the current limit, then it behaves as a constant-current source.",
    formulas: ["Vout = V_set (while I < I_limit)", "I = V / R_load"],
    uses: ["Powering any circuit under test"],
  },
  vac: {
    what: "AC voltage source (sine wave) with RMS / peak / peak-to-peak amplitude.",
    how: "Produces a sinusoid of the chosen frequency, phase and DC offset. The mains is 230 V RMS (325 V peak) at 50 Hz.",
    formulas: ["v(t) = Vp · sin(2π f t + φ) + offset", "Vrms = Vp / √2     Vpp = 2 · Vp", "Period T = 1 / f"],
    uses: ["Testing filters, rectifiers and transformers", "Simulating mains"],
    tip: "Choose how the amplitude is entered (peak, RMS or peak-to-peak) in the Inspector.",
  },
  battery_9v: {
    what: "9 V battery with internal resistance.",
    how: "An ideal 9 V source in series with a small internal resistance, so the terminal voltage sags under heavy load.",
    formulas: ["Vterminal = V − I · R_int"],
    uses: ["Portable low-power circuits"],
  },
  battery_aa: {
    what: "1.5 V AA cell with internal resistance.",
    how: "An ideal 1.5 V source with a small series resistance.",
    formulas: ["Vterminal = V − I · R_int", "Series cells add: V = V1 + V2 …"],
    uses: ["Low-voltage devices; stack several in series"],
  },
  battery_lipo: {
    what: "Lithium-polymer cell (≈ 3.7 V nominal).",
    how: "Source with low internal resistance and high current capability.",
    formulas: ["Vterminal = V − I · R_int"],
    uses: ["Compact, high-current portable power"],
  },
  sigen: {
    what: "Function generator: sine, square, triangle and sawtooth signals.",
    how: "Outputs the chosen waveform at a set frequency, amplitude (peak / RMS / pp), phase, DC offset and duty cycle (square). It has an output resistance.",
    formulas: ["Square duty D = t_high / T", "Sine: Vrms = Vp / √2", "Triangle / saw: Vrms = Vp / √3", "f = 1 / T"],
    uses: ["Exercising amplifiers, filters and logic", "Feeding the oscilloscope for measurements"],
  },
  pushbutton: {
    what: "Momentary switch: closed only while pressed.",
    how: "Click and hold the part on the canvas while the simulation is running.",
    formulas: ["Closed: R ≈ 0 Ω      Open: R = ∞"],
    uses: ["User input to a microcontroller or gate", "Reset and trigger buttons"],
    tip: "With a microcontroller use a pull-up or pull-down resistor (or INPUT_PULLUP) so the pin never floats.",
  },
  toggle_switch: {
    what: "Latching on/off switch.",
    how: "Click it on the canvas during simulation to flip its state.",
    formulas: ["Closed: R ≈ 0 Ω      Open: R = ∞"],
    uses: ["Power switches", "Selecting modes"],
  },
  dip_switch: {
    what: "Bank of four small on/off switches.",
    how: "Each of the four switches is independent; click one on the canvas to toggle it.",
    formulas: ["Each switch: closed R ≈ 0 Ω, open R = ∞"],
    uses: ["Binary configuration (4 bits)", "Setting addresses and options"],
  },
  ldr: {
    what: "Light-dependent resistor: resistance falls as light rises.",
    how: "The resistance follows a power law with illuminance in lux. Dark: hundreds of kΩ; bright: a few hundred Ω.",
    formulas: ["R = R10 · (10 / lux)^γ", "In a divider: Vout = Vcc · R_fixed / (R_fixed + R_LDR)"],
    uses: ["Light sensors and automatic night lights", "Dawn/dusk switches"],
  },
  ntc: {
    what: "NTC thermistor: resistance falls as temperature rises.",
    how: "Resistance follows the Beta equation. Often used in a divider to read temperature.",
    formulas: ["R = R25 · e^(β · (1/T − 1/298.15))   (T in kelvin)", "T = 1 / (1/T0 + ln(R/R25) / β)"],
    uses: ["Temperature measurement", "Inrush-current limiting"],
  },
  ptc: {
    what: "PTC thermistor: resistance rises with temperature.",
    how: "Resistance grows roughly linearly with temperature.",
    formulas: ["R = R25 · (1 + α · (T − 25 °C))"],
    uses: ["Over-current protection (resettable fuse)", "Heater elements"],
  },
  hcsr04: {
    what: "Ultrasonic distance sensor.",
    how: "A ≥ 10 µs pulse on TRIG makes it send an ultrasonic burst; ECHO stays high for the round-trip time. Distance is measured with pulseIn on ECHO.",
    formulas: ["distance = (t_echo · 343 m/s) / 2", "t_echo [µs] ≈ 58 · distance [cm]"],
    uses: ["Obstacle detection and robots", "Level measurement"],
    tip: "Powered from 5 V. Set the distance in the Inspector.",
  },
  led_rgb: {
    what: "Three LEDs (red, green, blue) in one package.",
    how: "Each colour has its own pin and needs its own series resistor. Mixing intensities gives other colours.",
    formulas: ["R = (Vsupply − Vf) / I_LED for each colour"],
    uses: ["Mood lighting, colour indicators", "PWM colour mixing"],
  },
  sevenseg: {
    what: "Seven LED segments (plus a dot) forming a digit.",
    how: "Each segment is an LED. Light the right combination to display 0–9. Each segment needs a series resistor.",
    formulas: ["R = (Vsupply − Vf) / I_segment"],
    uses: ["Counters, clocks and meters"],
  },
  lcd1602: {
    what: "16×2 character LCD with an HD44780 controller.",
    how: "Controlled with RS, E and 4 or 8 data lines. The microcontroller sends commands and characters (LiquidCrystal library).",
    formulas: ["Contrast: V0 pin voltage (≈ 0.5 V from a trimmer)", "4-bit mode: D4–D7 + RS + E"],
    uses: ["Showing sensor values and messages from a microcontroller"],
    tip: "Power VDD/VSS, wire RS, E, D4–D7 to the board, and fill in the sketch's lcd.print().",
  },
  buzzer: {
    what: "Electro-acoustic transducer that beeps when powered.",
    how: "Modelled as a resistance; it sounds when the voltage across it exceeds a threshold. Too much voltage destroys it.",
    formulas: ["I = V / R", "P = V² / R"],
    uses: ["Alarms and feedback beeps"],
  },
  dc_motor: {
    what: "DC motor: spins faster as the voltage rises.",
    how: "Modelled as a winding resistance; speed is proportional to the voltage. Overvoltage damages it.",
    formulas: ["Speed ∝ V", "I = V / R_winding", "P = V · I"],
    uses: ["Fans, wheels and pumps"],
    tip: "Drive it from a transistor and add a flyback diode across it.",
  },
  servo: {
    what: "Hobby servo whose shaft moves to a commanded angle.",
    how: "A 50 Hz control signal whose pulse width (1 – 2 ms) sets the angle (0 – 180°). Needs 4.8 – 6 V power.",
    formulas: ["angle = (t_pulse − 1 ms) / 1 ms · 180°", "Period = 20 ms"],
    uses: ["Robot arms and steering", "Positioning dials"],
  },
  relay: {
    what: "Electromagnetic switch: a small coil current switches a separate contact.",
    how: "When the coil current is high enough the armature pulls in and connects COM to NO (and releases NC). It isolates the control circuit from the load.",
    formulas: ["I_coil = V / R_coil", "Pull-in when V_coil ≥ V_pull", "Back-EMF spike: V = L · dI/dt"],
    uses: ["Switching mains or high-current loads", "Isolation"],
    tip: "Put a flyback diode across the coil and drive it with a transistor.",
  },
  dmm: {
    what: "Digital multimeter measuring DC/AC voltage, current and resistance.",
    how: "Connect it in parallel with a component to read voltage, in series to read current. In AC modes it shows the true RMS value.",
    formulas: ["True RMS: Vrms = √(mean(v²))", "Sine: Vrms = Vpeak / √2"],
    uses: ["Checking voltages, currents and resistances while debugging"],
    tip: "Choose the measurement mode in the Inspector. Current mode must be wired in series.",
  },
  scope: {
    what: "Two-channel oscilloscope: plots voltage against time.",
    how: "Each channel shows the voltage between its input and GND. The trigger aligns each sweep so repeating waves stand still. AC coupling removes the DC level; X–Y mode plots CH1 against CH2.",
    formulas: ["Period T = 1 / f", "Amplitude = divisions × V/div", "Time span = 10 × time/div"],
    uses: ["Viewing waveforms, ripple, phase shift and timing", "Measuring frequency, Vpp and RMS"],
    tip: "Press AUTO to fit the signal. Open the instruments dock for the full controls.",
  },
  logic_analyzer: {
    what: "Eight-channel logic analyser showing digital signals over time.",
    how: "Each channel is thresholded into 0 / 1 and drawn as a digital trace.",
    formulas: ["Logic 1 when V > threshold"],
    uses: ["Debugging digital circuits, buses and microcontroller outputs"],
  },
};

/** Help for a kind, falling back to the catalog description so every part always has something to show. */
export function getHelp(kind: string, fallback: string): ComponentHelp {
  return HELP[kind] ?? { what: fallback, how: "", formulas: [], uses: [] };
}
