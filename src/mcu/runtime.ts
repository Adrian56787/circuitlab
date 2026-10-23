import type { BoardSpec } from "./boards";
import type { McuIo } from "./io";

/** What the electrical model gives the runtime. */
export interface PinBus {
  /** voltage of the pin (by Arduino pin number) relative to the MCU ground */
  volts(pin: number): number;
  /** present supply voltage */
  vdd(): number;
}

export interface Pin {
  mode: "in" | "out";
  /** commanded level (for inputs: 1 = pull-up enabled, AVR style) */
  level: 0 | 1;
  pulldown: boolean;
  pwm: { period: number; duty: number; t0: number } | null;
  /** effective output level for the step that starts now */
  drive: 0 | 1;
}

export interface Program {
  init: () => Generator<unknown, void, unknown>;
  setup: () => Generator<unknown, void, unknown>;
  loop: () => Generator<unknown, void, unknown>;
}

interface Ev {
  t: number;
  apply: () => void;
}

interface Isr {
  fn: () => Generator<unknown, void, unknown>;
  mode: number;
  last: number;
}

const QUANT = 20e-6;

const TYPED = {
  i8: Int8Array,
  u8: Uint8Array,
  i16: Int16Array,
  u16: Uint16Array,
  i32: Int32Array,
  u32: Uint32Array,
  f64: Float64Array,
} as const;

export class McuRuntime {
  readonly pins = new Map<number, Pin>();
  /** sim time at which the program was last resumed */
  now = 0;
  /** accumulated cost of non-blocking work since the last resume */
  pending = 0;
  wake = 0;
  dead = false;
  error = "";
  readonly Z = new Float64Array(4096);
  Servo: new () => unknown;
  LiquidCrystal: new (...a: number[]) => unknown;

  private gen: Generator<unknown, void, unknown> | null = null;
  private cond: (() => boolean) | null = null;
  private events: Ev[] = [];
  private bus: PinBus | null = null;
  private isrs = new Map<number, Isr>();
  private rngState = 1;
  private baud = 9600;
  private readonly warned = new Set<string>();
  private adcBits: number;
  private started = false;
  private simNow = 0;

  private readonly prog: Program;

  constructor(
    makeProgram: (rt: McuRuntime) => Program,
    readonly board: BoardSpec,
    readonly io: McuIo,
  ) {
    this.adcBits = board.adcBits;
    for (const n of board.pins.keys()) this.pins.set(n, { mode: "in", level: 0, pulldown: false, pwm: null, drive: 0 });
    const rt = this;
    this.Servo = class {
      private pin = -1;
      private angle = 90;
      attach(pin: number): void {
        this.pin = pin;
        rt.pinMode(pin, 1);
      }
      detach(): void {
        if (this.pin >= 0) rt.setPwmAt(this.pin, null, 0);
        this.pin = -1;
      }
      attached(): boolean {
        return this.pin >= 0;
      }
      write(a: number): void {
        this.angle = Math.max(0, Math.min(180, a));
        this.writeMicroseconds(544 + (this.angle * (2400 - 544)) / 180);
      }
      writeMicroseconds(us: number): void {
        if (this.pin < 0) return;
        const w = Math.max(400, Math.min(2600, us)) * 1e-6;
        rt.setPwmAt(this.pin, 0.02, w / 0.02);
      }
      read(): number {
        return Math.round(this.angle);
      }
    };
    this.LiquidCrystal = makeLcdClass(rt);
    this.prog = makeProgram(this);
  }

  // ───────── lifecycle (called by the device)

  bind(bus: PinBus): void {
    this.bus = bus;
  }

  /** Program (re)start, e.g. after power-up. */
  restart(now: number): void {
    this.gen = null;
    this.cond = null;
    this.events = [];
    this.isrs.clear();
    this.dead = false;
    this.error = "";
    this.started = false;
    this.pending = 0;
    this.now = now;
    this.wake = now;
    for (const p of this.pins.values()) {
      p.mode = "in";
      p.level = 0;
      p.pulldown = false;
      p.pwm = null;
      p.drive = 0;
    }
    this.io.setStatus("running");
  }

  /** Called after each accepted solver step. Runs the program up to simulation time `t`. */
  advance(t: number): void {
    this.simNow = t;
    if (this.dead) return;
    if (!this.started) {
      this.started = true;
      this.gen = this.main();
      this.now = t;
      this.wake = t;
    }
    this.applyDue(t);
    this.checkInterrupts();
    let guard = 0;
    while (!this.dead && guard++ < 20000) {
      const due = this.cond ? this.cond() || t >= this.wake - 1e-12 : t >= this.wake - 1e-12;
      if (!due) break;
      this.cond = null;
      this.now = t;
      this.pending = 0;
      try {
        const r = this.gen!.next();
        if (r.done) {
          this.dead = true;
          this.io.setStatus("off", "Program ended.");
        }
      } catch (e) {
        this.fail(e instanceof Error ? e.message : String(e));
      }
      this.applyDue(t);
    }
    this.updatePwm(t);
  }

  /** Earliest future time at which the runtime needs a solver step boundary. */
  nextTime(t: number): number {
    let best = Infinity;
    if (!this.dead) {
      best = Math.min(best, this.wake);
      const ev = this.events[0];
      if (ev) best = Math.min(best, ev.t);
    }
    for (const p of this.pins.values()) {
      if (p.mode === "out" && p.pwm) best = Math.min(best, this.nextEdge(p, t));
    }
    return best;
  }

  private nextEdge(p: Pin, t: number): number {
    const w = p.pwm!;
    const x = (t - w.t0) / w.period;
    if (x < 0) return w.t0;
    let f = x - Math.floor(x);
    if (f > 1 - 1e-7) f = 0;
    const d = w.duty;
    const dt = f < d - 1e-9 ? (d - f) * w.period : (1 - f) * w.period;
    return t + Math.max(dt, 1e-9);
  }

  private level(p: Pin, t: number): 0 | 1 {
    const w = p.pwm;
    if (!w) return p.level;
    if (t < w.t0) return p.level;
    const x = (t - w.t0) / w.period;
    let f = x - Math.floor(x);
    if (f > 1 - 1e-7) f = 0;
    return f < w.duty - 1e-9 ? 1 : 0;
  }

  private updatePwm(t: number): void {
    for (const p of this.pins.values()) p.drive = this.level(p, t + 1e-10);
  }

  private fail(msg: string): void {
    this.dead = true;
    this.error = msg;
    this.io.write(`\n[runtime error] ${msg}\n`);
    this.io.setStatus("error", msg);
  }

  private applyDue(t: number): void {
    while (this.events.length && this.events[0]!.t <= t + 1e-12) this.events.shift()!.apply();
    this.updatePwm(t);
  }

  private schedule(apply: () => void, at = this.now + this.pending): void {
    const ev: Ev = { t: at, apply };
    let i = this.events.length;
    while (i > 0 && this.events[i - 1]!.t > at) i--;
    this.events.splice(i, 0, ev);
  }

  private pin(n: number): Pin | null {
    const p = this.pins.get(n);
    if (!p) {
      const key = `pin${n}`;
      if (!this.warned.has(key)) {
        this.warned.add(key);
        this.io.write(`[warning] pin ${n} does not exist on ${this.board.name}.\n`);
      }
      return null;
    }
    return p;
  }

  private digitalLevel(n: number): number {
    const p = this.pins.get(n);
    if (!p) return 0;
    if (p.mode === "out") return p.drive;
    const vdd = this.bus?.vdd() ?? this.board.vhigh;
    const v = this.bus?.volts(n) ?? 0;
    return v > vdd * 0.5 ? 1 : 0;
  }

  private checkInterrupts(): void {
    for (const [n, isr] of this.isrs) {
      const lv = this.digitalLevel(n);
      const prev = isr.last;
      isr.last = lv;
      if (lv === prev) continue;
      const fire = isr.mode === 1 || (isr.mode === 2 && lv === 1) || (isr.mode === 3 && lv === 0) || (isr.mode === 0 && lv === 0);
      if (!fire) continue;
      const savedPending = this.pending;
      const savedNow = this.now;
      this.now = this.simNow;
      this.pending = 0;
      try {
        const g = isr.fn();
        for (let i = 0; i < 2000; i++) if (g.next().done) break;
      } catch (e) {
        this.fail(e instanceof Error ? e.message : String(e));
      }
      this.pending += savedPending;
      this.now = savedNow;
    }
  }

  // ───────── main program

  private *main(): Generator<unknown, void, unknown> {
    yield* this.prog.init();
    yield* this.prog.setup();
    for (;;) {
      yield* this.prog.loop();
      this.pending += this.board.costs.tick * 4;
      if (this.pending >= QUANT) yield* this.spin();
    }
  }

  // ───────── generated-code API: timing

  tk(): boolean {
    this.pending += this.board.costs.tick;
    return this.pending >= QUANT;
  }

  *sleepFor(sec: number): Generator<unknown, void, unknown> {
    this.wake = this.now + this.pending + Math.max(0, sec);
    this.pending = 0;
    yield;
  }

  *spin(): Generator<unknown, void, unknown> {
    yield* this.sleepFor(0);
  }

  private *syncIfNeeded(): Generator<unknown, void, unknown> {
    if (this.pending >= QUANT) yield* this.sleepFor(0);
  }

  *delay(ms: number): Generator<unknown, void, unknown> {
    yield* this.sleepFor(ms / 1000);
  }

  *delayUs(us: number): Generator<unknown, void, unknown> {
    yield* this.sleepFor(us / 1e6);
  }

  millis(): number {
    return Math.floor((this.now + this.pending) * 1000) >>> 0;
  }
  micros(): number {
    return Math.floor((this.now + this.pending) * 1e6) >>> 0;
  }

  /** Block until `cond()` or the deadline; returns whether cond became true. */
  private *waitFor(cond: () => boolean, timeout: number): Generator<unknown, boolean, unknown> {
    if (cond()) return true;
    this.cond = cond;
    this.wake = this.now + this.pending + timeout;
    this.pending = 0;
    yield;
    return cond();
  }

  // ───────── pins

  pinMode(n: number, mode: number): void {
    const p = this.pin(n);
    if (!p) return;
    this.pending += this.board.costs.pinMode;
    this.schedule(() => {
      if (mode === 1) {
        if (this.board.inputOnly.has(n)) return;
        p.mode = "out";
        p.pulldown = false;
      } else {
        p.mode = "in";
        p.pwm = null;
        p.level = mode === 2 ? 1 : 0;
        p.pulldown = mode === 3;
      }
    });
  }

  digitalWrite(n: number, v: number): void {
    const p = this.pin(n);
    if (!p) return;
    this.pending += this.board.costs.digitalWrite;
    const lv: 0 | 1 = v ? 1 : 0;
    this.schedule(() => {
      p.level = lv;
      p.pwm = null;
    });
  }

  *digitalRead(n: number): Generator<unknown, number, unknown> {
    this.pending += this.board.costs.digitalRead;
    yield* this.syncIfNeeded();
    return this.pin(n) ? this.digitalLevel(n) : 0;
  }

  *analogRead(n: number): Generator<unknown, number, unknown> {
    this.pending += this.board.costs.analogRead;
    yield* this.sleepFor(0);
    if (!this.pin(n)) return 0;
    const vdd = this.bus?.vdd() ?? this.board.vhigh;
    const v = this.bus?.volts(n) ?? 0;
    const max = 2 ** this.adcBits - 1;
    return Math.max(0, Math.min(max, Math.round((v / vdd) * max)));
  }

  analogReadResolution(bits: number): void {
    if (this.board.kind === "esp32") this.adcBits = Math.max(9, Math.min(12, bits));
  }

  analogWrite(n: number, val: number): void {
    const p = this.pin(n);
    if (!p) return;
    this.pending += this.board.costs.analogWrite;
    const v = Math.max(0, Math.min(255, Math.round(val)));
    const pwmOk = this.board.allPwm || this.board.pwmPins.has(n);
    const at = this.now + this.pending;
    this.schedule(() => {
      if (this.board.inputOnly.has(n)) return;
      p.mode = "out";
      if (!pwmOk) {
        p.level = v < 128 ? 0 : 1;
        p.pwm = null;
      } else if (v <= 0) {
        p.level = 0;
        p.pwm = null;
      } else if (v >= 255) {
        p.level = 1;
        p.pwm = null;
      } else {
        const period = 1 / this.board.pwmHz(n);
        // keep the running phase when only the duty changes
        p.pwm = { period, duty: v / 255, t0: p.pwm && p.pwm.period === period ? p.pwm.t0 : at };
      }
    }, at);
  }

  /** Immediate (program-time) PWM change used by Servo / tone. */
  setPwmAt(n: number, period: number | null, duty: number): void {
    const p = this.pin(n);
    if (!p) return;
    const at = this.now + this.pending;
    this.schedule(() => {
      if (period === null) {
        p.pwm = null;
        p.level = 0;
      } else {
        p.mode = "out";
        const prev = p.pwm;
        p.pwm = { period, duty, t0: prev && Math.abs(prev.period - period) < 1e-12 ? prev.t0 : at };
      }
    }, at);
  }

  tone(n: number, freq: number, dur?: number): void {
    if (freq <= 0) return;
    this.setPwmAt(n, 1 / freq, 0.5);
    if (dur && dur > 0) {
      const at = this.now + this.pending + dur / 1000;
      this.schedule(() => this.setPwmAt(n, null, 0), at);
    }
  }

  noTone(n: number): void {
    this.setPwmAt(n, null, 0);
  }

  *pulseIn(n: number, level: number, timeoutUs = 1_000_000): Generator<unknown, number, unknown> {
    yield* this.sleepFor(0);
    const timeout = timeoutUs / 1e6;
    const deadline = this.now + timeout;
    const want = level ? 1 : 0;
    const read = (): number => this.digitalLevel(n);
    // wait for any pulse already in progress to end
    if (!(yield* this.waitFor(() => read() !== want, deadline - this.now))) return 0;
    if (!(yield* this.waitFor(() => read() === want, deadline - this.now))) return 0;
    const t1 = this.now;
    if (!(yield* this.waitFor(() => read() !== want, deadline - this.now))) return 0;
    return Math.round((this.now - t1) * 1e6);
  }

  *shiftOut(data: number, clock: number, order: number, val: number): Generator<unknown, void, unknown> {
    for (let i = 0; i < 8; i++) {
      const bit = order ? (val >> (7 - i)) & 1 : (val >> i) & 1;
      this.digitalWrite(data, bit);
      this.digitalWrite(clock, 1);
      this.digitalWrite(clock, 0);
      yield* this.syncIfNeeded();
    }
  }

  *shiftIn(data: number, clock: number, order: number): Generator<unknown, number, unknown> {
    let v = 0;
    for (let i = 0; i < 8; i++) {
      this.digitalWrite(clock, 1);
      const bit = yield* this.digitalRead(data);
      v |= order ? bit << (7 - i) : bit << i;
      this.digitalWrite(clock, 0);
    }
    return v;
  }

  attachInterrupt(n: number, fn: () => Generator<unknown, void, unknown>, mode: number): void {
    if (!this.pin(n)) return;
    this.isrs.set(n, { fn, mode, last: this.digitalLevel(n) });
  }
  detachInterrupt(n: number): void {
    this.isrs.delete(n);
  }

  // ───────── math / helpers

  div(a: number, b: number): number {
    return b === 0 ? 0 : Math.trunc(a / b);
  }
  mod(a: number, b: number): number {
    return b === 0 ? 0 : a % b;
  }
  min(a: number, b: number): number {
    return a < b ? a : b;
  }
  max(a: number, b: number): number {
    return a > b ? a : b;
  }
  constrain(x: number, a: number, b: number): number {
    return x < a ? a : x > b ? b : x;
  }
  map(x: number, a: number, b: number, c: number, d: number): number {
    return b === a ? 0 : Math.trunc(((x - a) * (d - c)) / (b - a)) + c;
  }
  mapf(x: number, a: number, b: number, c: number, d: number): number {
    return b === a ? 0 : ((x - a) * (d - c)) / (b - a) + c;
  }
  pow(a: number, b: number): number {
    return Math.pow(a, b);
  }
  atan2(a: number, b: number): number {
    return Math.atan2(a, b);
  }
  fmod(a: number, b: number): number {
    return a % b;
  }
  hypot(a: number, b: number): number {
    return Math.hypot(a, b);
  }
  randomSeed(s: number): void {
    this.rngState = (s >>> 0) || 1;
  }
  private rnd(): number {
    // mulberry32
    this.rngState = (this.rngState + 0x6d2b79f5) >>> 0;
    let t = this.rngState;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  random(a: number, b?: number): number {
    const lo = b === undefined ? 0 : a;
    const hi = b === undefined ? a : b;
    if (hi <= lo) return lo;
    return lo + Math.floor(this.rnd() * (hi - lo));
  }
  isDigit(c: number): number {
    return c >= 48 && c <= 57 ? 1 : 0;
  }
  isAlpha(c: number): number {
    return (c >= 65 && c <= 90) || (c >= 97 && c <= 122) ? 1 : 0;
  }
  isAlphaNumeric(c: number): number {
    return this.isDigit(c) || this.isAlpha(c) ? 1 : 0;
  }
  isSpace(c: number): number {
    return c === 32 || (c >= 9 && c <= 13) ? 1 : 0;
  }
  isUpperCase(c: number): number {
    return c >= 65 && c <= 90 ? 1 : 0;
  }
  isLowerCase(c: number): number {
    return c >= 97 && c <= 122 ? 1 : 0;
  }
  isPunct(c: number): number {
    return c > 32 && c < 127 && !this.isAlphaNumeric(c) ? 1 : 0;
  }
  isAscii(c: number): number {
    return c >= 0 && c < 128 ? 1 : 0;
  }
  isHexadecimalDigit(c: number): number {
    return /[0-9a-fA-F]/.test(String.fromCharCode(c)) ? 1 : 0;
  }
  toUpper(c: number): number {
    return c >= 97 && c <= 122 ? c - 32 : c;
  }
  toLower(c: number): number {
    return c >= 65 && c <= 90 ? c + 32 : c;
  }

  // ───────── strings & arrays

  s(v: number | string, tag: string): string {
    switch (tag) {
      case "s":
        return String(v);
      case "c":
        return String.fromCharCode(Number(v) & 255);
      case "f":
        return fmtFloat(Number(v), 2);
      case "a":
        return this.cstr(v as unknown as ArrayLike<number>);
      default:
        return String(Math.trunc(Number(v)));
    }
  }
  cstr(a: ArrayLike<number>): string {
    let out = "";
    for (let i = 0; i < a.length && a[i] !== 0; i++) out += String.fromCharCode(a[i]! & 255);
    return out;
  }
  arr(kind: keyof typeof TYPED, dims: number[], init: unknown): unknown {
    const build = (level: number, data: unknown): unknown => {
      const n = dims[level]!;
      if (level === dims.length - 1) {
        const a = new TYPED[kind](n);
        if (Array.isArray(data)) for (let i = 0; i < Math.min(n, data.length); i++) a[i] = data[i] as number;
        return a;
      }
      const rows: unknown[] = [];
      for (let i = 0; i < n; i++) rows.push(build(level + 1, Array.isArray(data) ? data[i] : null));
      return rows;
    };
    return build(0, init);
  }
  chAt(s: string, i: number): number {
    return i >= 0 && i < s.length ? s.charCodeAt(i) & 255 : 0;
  }
  sub(s: string, a: number, b?: number): string {
    return b === undefined ? s.slice(Math.max(0, a)) : s.slice(Math.max(0, a), Math.max(0, b));
  }
  indexOf(s: string, x: string, from = 0): number {
    return s.indexOf(x, from);
  }
  lastIndexOf(s: string, x: string, from?: number): number {
    return from === undefined ? s.lastIndexOf(x) : s.lastIndexOf(x, from);
  }
  toInt(s: string): number {
    const m = /^\s*[+-]?\d+/.exec(s);
    return m ? parseInt(m[0], 10) | 0 : 0;
  }
  toFloat(s: string): number {
    const m = /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s);
    return m ? parseFloat(m[0]) : 0;
  }
  strcmp(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  repl(s: string, a: string, b: string): string {
    return a === "" ? s : s.split(a).join(b);
  }
  remove(s: string, i: number, n?: number): string {
    return n === undefined ? s.slice(0, Math.max(0, i)) : s.slice(0, Math.max(0, i)) + s.slice(Math.max(0, i) + n);
  }
  strcpy(dst: Int8Array, src: string): void {
    dst.fill(0);
    for (let i = 0; i < Math.min(dst.length - 1, src.length); i++) dst[i] = src.charCodeAt(i);
  }
  strcat(dst: Int8Array, src: string): void {
    const cur = this.cstr(dst);
    this.strcpy(dst, cur + src);
  }
  dtostrf(v: number, width: number, prec: number, dst: Int8Array): void {
    this.strcpy(dst, fmtFloat(v, Math.max(0, prec)).padStart(Math.max(0, width), " "));
  }
  sprintf(dst: Int8Array, max: number, fmt: string, args: [number | string, string][]): number {
    const out = format(fmt, args);
    dst.fill(0);
    const lim = max < 0 ? dst.length - 1 : Math.min(dst.length - 1, max - 1);
    for (let i = 0; i < Math.min(lim, out.length); i++) dst[i] = out.charCodeAt(i);
    return out.length;
  }
  printf(fmt: string, args: [number | string, string][]): void {
    this.sWriteText(format(fmt, args));
  }

  // ───────── Serial

  sBegin(baud: number): void {
    this.baud = baud > 0 ? baud : 9600;
    this.io.baud = this.baud;
  }
  private sWriteText(text: string): void {
    this.pending += (text.length * 10) / this.baud;
    this.io.write(text);
  }
  sPrint(v: number | string, tag: string, arg: number, nl: number): void {
    let text: string;
    switch (tag) {
      case "s":
        text = String(v);
        break;
      case "c":
        text = String.fromCharCode(Number(v) & 255);
        break;
      case "f":
        text = fmtFloat(Number(v), arg >= 0 ? arg : 2);
        break;
      default: {
        const n = Math.trunc(Number(v));
        if (arg > 1 && arg !== 10) text = (n < 0 ? n >>> 0 : n).toString(arg).toUpperCase();
        else text = String(n);
      }
    }
    this.sWriteText(nl ? `${text}\r\n` : text);
  }
  sWrite(v: number): void {
    this.sWriteText(String.fromCharCode(v & 255));
  }
  sAvailable(): number {
    return this.io.rx.length;
  }
  sRead(): number {
    return this.io.rx.length ? this.io.rx.shift()! : -1;
  }
  sPeek(): number {
    return this.io.rx.length ? this.io.rx[0]! : -1;
  }
  sParseInt(): number {
    while (this.io.rx.length && !/[-0-9]/.test(String.fromCharCode(this.io.rx[0]!))) this.io.rx.shift();
    let s = "";
    while (this.io.rx.length && /[-0-9]/.test(String.fromCharCode(this.io.rx[0]!))) s += String.fromCharCode(this.io.rx.shift()!);
    return parseInt(s, 10) | 0 || 0;
  }
  sParseFloat(): number {
    while (this.io.rx.length && !/[-0-9.]/.test(String.fromCharCode(this.io.rx[0]!))) this.io.rx.shift();
    let s = "";
    while (this.io.rx.length && /[-0-9.]/.test(String.fromCharCode(this.io.rx[0]!))) s += String.fromCharCode(this.io.rx.shift()!);
    return parseFloat(s) || 0;
  }
  sReadString(): string {
    const s = this.io.rx.map((c) => String.fromCharCode(c)).join("");
    this.io.rx.length = 0;
    return s;
  }
  sReadStringUntil(term: number): string {
    let s = "";
    while (this.io.rx.length) {
      const c = this.io.rx.shift()!;
      if (c === term) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
}

// ───────── formatting

export function fmtFloat(v: number, digits: number): string {
  if (Number.isNaN(v)) return "nan";
  if (!Number.isFinite(v)) return v > 0 ? "inf" : "-inf";
  return v.toFixed(Math.max(0, Math.min(20, digits)));
}

function format(fmt: string, args: [number | string, string][]): string {
  let ai = 0;
  return fmt.replace(/%([-+ 0#]*)(\d+)?(?:\.(\d+))?(?:hh|h|ll|l|z)?([diucsfFeEgGxXop%])/g, (_m, flags: string, width: string | undefined, prec: string | undefined, type: string) => {
    if (type === "%") return "%";
    const a = args[ai++];
    const v = a ? a[0] : 0;
    let body: string;
    switch (type) {
      case "d":
      case "i":
        body = String(Math.trunc(Number(v)));
        break;
      case "u":
        body = String(Math.trunc(Number(v)) >>> 0);
        break;
      case "c":
        body = typeof v === "string" ? v.slice(0, 1) : String.fromCharCode(Number(v) & 255);
        break;
      case "s":
        body = String(v);
        if (prec !== undefined) body = body.slice(0, Number(prec));
        break;
      case "f":
      case "F":
        body = Number(v).toFixed(prec === undefined ? 6 : Number(prec));
        break;
      case "e":
      case "E":
        body = Number(v).toExponential(prec === undefined ? 6 : Number(prec));
        break;
      case "g":
      case "G":
        body = String(Number(Number(v).toPrecision(prec === undefined ? 6 : Math.max(1, Number(prec)))));
        break;
      case "x":
        body = (Math.trunc(Number(v)) >>> 0).toString(16);
        break;
      case "X":
        body = (Math.trunc(Number(v)) >>> 0).toString(16).toUpperCase();
        break;
      case "o":
        body = (Math.trunc(Number(v)) >>> 0).toString(8);
        break;
      default:
        body = String(v);
    }
    if (flags.includes("+") && /^[difFeEgG]$/.test(type) && Number(v) >= 0) body = `+${body}`;
    const w = width ? Number(width) : 0;
    if (body.length < w) {
      if (flags.includes("-")) body = body.padEnd(w, " ");
      else if (flags.includes("0") && type !== "s" && type !== "c") {
        const neg = /^[+-]/.test(body) ? body[0]! : "";
        body = neg + body.slice(neg.length).padStart(w - neg.length, "0");
      } else body = body.padStart(w, " ");
    }
    return body;
  });
}

// ───────── LiquidCrystal (bit-banged HD44780 driver, like the Arduino library)

function makeLcdClass(rt: McuRuntime): new (...a: number[]) => unknown {
  return class Lcd {
    private rs: number;
    private en: number;
    private data: number[];
    private fourBit: boolean;
    private cols = 16;
    private rows = 2;
    private ctrl = 0x04; // display on, cursor off, blink off
    private mode = 0x02; // increment, no shift
    private fn = 0;

    constructor(...a: number[]) {
      // (rs, en, d4..d7) | (rs, rw, en, d4..d7) | (rs, en, d0..d7) | (rs, rw, en, d0..d7)
      if (a.length === 6) {
        this.rs = a[0]!;
        this.en = a[1]!;
        this.data = a.slice(2);
        this.fourBit = true;
      } else if (a.length === 7) {
        this.rs = a[0]!;
        this.en = a[2]!;
        this.data = a.slice(3);
        this.fourBit = true;
      } else if (a.length === 10) {
        this.rs = a[0]!;
        this.en = a[1]!;
        this.data = a.slice(2);
        this.fourBit = false;
      } else if (a.length === 11) {
        this.rs = a[0]!;
        this.en = a[2]!;
        this.data = a.slice(3);
        this.fourBit = false;
      } else {
        this.rs = a[0] ?? 0;
        this.en = a[1] ?? 0;
        this.data = a.slice(2);
        this.fourBit = a.length < 10;
      }
    }

    private *pulse(): Generator<unknown, void, unknown> {
      rt.digitalWrite(this.en, 0);
      yield* rt.delayUs(1);
      rt.digitalWrite(this.en, 1);
      yield* rt.delayUs(1);
      rt.digitalWrite(this.en, 0);
      yield* rt.delayUs(100);
    }
    private *write4(v: number): Generator<unknown, void, unknown> {
      for (let i = 0; i < 4; i++) rt.digitalWrite(this.data[i]!, (v >> i) & 1);
      yield* this.pulse();
    }
    private *write8(v: number): Generator<unknown, void, unknown> {
      for (let i = 0; i < 8; i++) rt.digitalWrite(this.data[i]!, (v >> i) & 1);
      yield* this.pulse();
    }
    private *send(v: number, rsLevel: number): Generator<unknown, void, unknown> {
      rt.digitalWrite(this.rs, rsLevel);
      if (this.fourBit) {
        yield* this.write4(v >> 4);
        yield* this.write4(v & 15);
      } else yield* this.write8(v);
    }
    private *command(v: number): Generator<unknown, void, unknown> {
      yield* this.send(v, 0);
    }

    *begin(cols: number, rows: number): Generator<unknown, void, unknown> {
      this.cols = cols;
      this.rows = rows;
      rt.pinMode(this.rs, 1);
      rt.pinMode(this.en, 1);
      for (const d of this.data) rt.pinMode(d, 1);
      this.fn = (this.fourBit ? 0 : 0x10) | (rows > 1 ? 0x08 : 0);
      yield* rt.delayUs(50000);
      rt.digitalWrite(this.rs, 0);
      rt.digitalWrite(this.en, 0);
      if (this.fourBit) {
        yield* this.write4(0x03);
        yield* rt.delayUs(4500);
        yield* this.write4(0x03);
        yield* rt.delayUs(4500);
        yield* this.write4(0x03);
        yield* rt.delayUs(150);
        yield* this.write4(0x02);
      } else {
        yield* this.command(0x20 | this.fn);
        yield* rt.delayUs(4500);
        yield* this.command(0x20 | this.fn);
        yield* rt.delayUs(150);
        yield* this.command(0x20 | this.fn);
      }
      yield* this.command(0x20 | this.fn);
      yield* this.command(0x08 | this.ctrl);
      yield* this.cmd("clear");
      yield* this.command(0x04 | this.mode);
    }

    *cmd(name: string): Generator<unknown, void, unknown> {
      switch (name) {
        case "clear":
          yield* this.command(0x01);
          yield* rt.delayUs(2000);
          break;
        case "home":
          yield* this.command(0x02);
          yield* rt.delayUs(2000);
          break;
        case "display":
          this.ctrl |= 0x04;
          yield* this.command(0x08 | this.ctrl);
          break;
        case "noDisplay":
          this.ctrl &= ~0x04;
          yield* this.command(0x08 | this.ctrl);
          break;
        case "cursor":
          this.ctrl |= 0x02;
          yield* this.command(0x08 | this.ctrl);
          break;
        case "noCursor":
          this.ctrl &= ~0x02;
          yield* this.command(0x08 | this.ctrl);
          break;
        case "blink":
          this.ctrl |= 0x01;
          yield* this.command(0x08 | this.ctrl);
          break;
        case "noBlink":
          this.ctrl &= ~0x01;
          yield* this.command(0x08 | this.ctrl);
          break;
        case "scrollDisplayLeft":
          yield* this.command(0x18);
          break;
        case "scrollDisplayRight":
          yield* this.command(0x1c);
          break;
        case "autoscroll":
          this.mode |= 0x01;
          yield* this.command(0x04 | this.mode);
          break;
        case "noAutoscroll":
          this.mode &= ~0x01;
          yield* this.command(0x04 | this.mode);
          break;
        default:
          break;
      }
    }

    *setCursor(col: number, row: number): Generator<unknown, void, unknown> {
      const offs = [0x00, 0x40, this.cols, 0x40 + this.cols];
      const r = Math.max(0, Math.min(this.rows - 1, row));
      yield* this.command(0x80 | ((col + offs[r]!) & 0x7f));
    }

    *createChar(loc: number, bytes: ArrayLike<number>): Generator<unknown, void, unknown> {
      yield* this.command(0x40 | ((loc & 7) << 3));
      for (let i = 0; i < 8; i++) yield* this.send(bytes[i] ?? 0, 1);
    }

    *print(v: number | string, tag: string, base?: number): Generator<unknown, void, unknown> {
      let text: string;
      if (tag === "s" || tag === "a") text = String(v);
      else if (tag === "c") text = String.fromCharCode(Number(v) & 255);
      else if (tag === "f") text = fmtFloat(Number(v), base !== undefined && base >= 0 ? base : 2);
      else {
        const n = Math.trunc(Number(v));
        text = base && base > 1 && base !== 10 ? (n < 0 ? n >>> 0 : n).toString(base).toUpperCase() : String(n);
      }
      for (let i = 0; i < text.length; i++) yield* this.send(text.charCodeAt(i) & 255, 1);
    }
  };
}
