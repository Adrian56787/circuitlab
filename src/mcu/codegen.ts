import { boardFor, type BoardSpec } from "./boards";
import { CompileError, lex } from "./lexer";
import {
  parseProgram,
  type Declarator,
  type Expr,
  type Param,
  type Program,
  type Stmt,
  type TopLevel,
  type TypeSpec,
} from "./parser";

// ───────────────────────── types ─────────────────────────

type K = "void" | "int" | "float" | "bool" | "char" | "String" | "Servo" | "LiquidCrystal" | "fn";

interface VType {
  k: K;
  bits: number;
  signed: boolean;
  /** array dimensions (element counts); undefined for scalars */
  dims?: number[];
}

const T_VOID: VType = { k: "void", bits: 0, signed: true };
const T_FLOAT: VType = { k: "float", bits: 32, signed: true };
const T_STRING: VType = { k: "String", bits: 0, signed: true };
const T_BOOL: VType = { k: "bool", bits: 8, signed: false };
const T_FN: VType = { k: "fn", bits: 0, signed: true };

interface VarInfo {
  js: string;
  type: VType;
  constVal?: number;
}

interface FuncInfo {
  js: string;
  ret: VType;
  params: { type: VType; isArray: boolean }[];
}

export interface CompileResult {
  ok: boolean;
  /** JS source of the generated program factory body (takes `R`) */
  js: string;
  errors: { line: number; col: number; message: string }[];
  includes: string[];
  board: string;
}

interface Typed {
  c: string;
  t: VType;
}

const isNum = (t: VType): boolean => t.k === "int" || t.k === "char" || t.k === "bool";
const isIntLike = isNum;

// ───────────────────────── generator ─────────────────────────

class Gen {
  private readonly intBits: number;
  private scopes: Map<string, VarInfo>[] = [new Map()];
  private funcs = new Map<string, FuncInfo>();
  private temps: string[] = [];
  private tmpN = 0;
  private statics: string[] = [];
  private curFn = "";
  private curRet: VType = T_VOID;
  private staticN = 0;

  constructor(private readonly board: BoardSpec) {
    this.intBits = board.intBits;
  }

  // ───────── type helpers

  private vt(ts: TypeSpec): VType {
    switch (ts.base) {
      case "void":
        return T_VOID;
      case "int":
        return { k: "int", bits: ts.bits, signed: ts.signed };
      case "float":
        return T_FLOAT;
      case "bool":
        return T_BOOL;
      case "char":
        if (ts.ptr > 0) return T_STRING;
        return { k: "char", bits: 8, signed: ts.signed };
      case "String":
        return T_STRING;
      case "Servo":
        return { k: "Servo", bits: 0, signed: true };
      case "LiquidCrystal":
        return { k: "LiquidCrystal", bits: 0, signed: true };
    }
  }

  private elem(t: VType): VType {
    return { k: t.k, bits: t.bits, signed: t.signed };
  }

  private promote(t: VType): VType {
    if (t.k === "bool" || t.k === "char") return { k: "int", bits: this.intBits, signed: true };
    if (t.k === "int" && t.bits < this.intBits) return { k: "int", bits: this.intBits, signed: true };
    return t;
  }

  private common(a: VType, b: VType): VType {
    if (a.k === "float" || b.k === "float") return T_FLOAT;
    const x = this.promote(a);
    const y = this.promote(b);
    if (x.bits > y.bits) return x;
    if (y.bits > x.bits) return y;
    return { k: "int", bits: x.bits, signed: x.signed && y.signed };
  }

  /** Wrap an integer-valued JS expression to the range of `t`. */
  private wrap(t: VType, c: string): string {
    if (t.k === "bool") return `((${c}) ? 1 : 0)`;
    if (t.k !== "int" && t.k !== "char") return c;
    switch (t.bits) {
      case 8:
        return t.signed ? `((${c}) << 24 >> 24)` : `((${c}) & 255)`;
      case 16:
        return t.signed ? `((${c}) << 16 >> 16)` : `((${c}) & 65535)`;
      case 32:
        return t.signed ? `((${c}) | 0)` : `((${c}) >>> 0)`;
      default:
        return `(${c})`;
    }
  }

  private fits(from: VType, to: VType): boolean {
    if (from.k === "bool") return true;
    if (from.bits > to.bits) return false;
    if (from.bits === to.bits) return from.signed === to.signed;
    return !from.signed || to.signed;
  }

  private kindTag(t: VType): string {
    if (t.dims && t.k === "char") return "a";
    switch (t.k) {
      case "float":
        return "f";
      case "char":
        return "c";
      case "String":
        return "s";
      default:
        return "i";
    }
  }

  /** Convert an expression to the destination type (assignment / argument / return conversion). */
  private conv(x: Typed, to: VType, line: number): string {
    const from = x.t;
    if (to.dims) {
      if (!from.dims) throw new CompileError("An array is required here.", line);
      return x.c;
    }
    switch (to.k) {
      case "int":
      case "char":
        if (from.k === "float") return this.wrap(to, `Math.trunc(${x.c})`);
        if (from.k === "String") throw new CompileError("Cannot convert a String to a number.", line);
        if (from.dims || from.k === "Servo" || from.k === "LiquidCrystal") throw new CompileError("Cannot convert this value to a number.", line);
        if (this.fits(from, to)) return x.c;
        return this.wrap(to, x.c);
      case "float":
        if (from.k === "String") throw new CompileError("Cannot convert a String to a number.", line);
        return x.c;
      case "bool":
        return from.k === "bool" ? x.c : `((${x.c}) ? 1 : 0)`;
      case "String":
        if (from.k === "String" && !from.dims) return x.c;
        return `R.s(${x.c}, "${this.kindTag(from)}")`;
      default:
        return x.c;
    }
  }

  // ───────── scopes

  private push(): void {
    this.scopes.push(new Map());
  }
  private pop(): void {
    this.scopes.pop();
  }
  private lookup(name: string): VarInfo | undefined {
    for (let i = this.scopes.length - 1; i >= 0; i--) {
      const v = this.scopes[i]!.get(name);
      if (v) return v;
    }
    return undefined;
  }
  private declare(name: string, type: VType, line: number, constVal?: number): VarInfo {
    const top = this.scopes[this.scopes.length - 1]!;
    if (top.has(name)) throw new CompileError(`"${name}" is already declared in this scope.`, line);
    const info: VarInfo = { js: `v_${name}`, type, constVal };
    top.set(name, info);
    return info;
  }
  private tmp(): string {
    const n = `$${++this.tmpN}`;
    this.temps.push(n);
    return n;
  }

  // ───────── constant evaluation

  private constEval(e: Expr): number | null {
    switch (e.k) {
      case "num":
        return e.v;
      case "chr":
        return e.v;
      case "id": {
        const v = this.lookup(e.name);
        if (v && v.constVal !== undefined) return v.constVal;
        if (e.name in this.board.constants) return this.board.constants[e.name]!;
        if (e.name === "true") return 1;
        if (e.name === "false") return 0;
        return null;
      }
      case "un": {
        const v = this.constEval(e.e);
        if (v === null) return null;
        return e.op === "-" ? -v : e.op === "+" ? v : e.op === "!" ? (v ? 0 : 1) : ~v;
      }
      case "bin": {
        const a = this.constEval(e.l);
        const b = this.constEval(e.r);
        if (a === null || b === null) return null;
        switch (e.op) {
          case "+": return a + b;
          case "-": return a - b;
          case "*": return a * b;
          case "/": return b === 0 ? null : Number.isInteger(a) && Number.isInteger(b) ? Math.trunc(a / b) : a / b;
          case "%": return b === 0 ? null : a % b;
          case "<<": return a * 2 ** b;
          case ">>": return Math.floor(a / 2 ** b);
          case "&": return a & b;
          case "|": return a | b;
          case "^": return a ^ b;
          default: return null;
        }
      }
      case "cast":
        return this.constEval(e.e);
      case "sizeof":
        return this.sizeofOf(e);
      default:
        return null;
    }
  }

  private sizeBytes(t: VType): number {
    let n = t.k === "float" ? 4 : t.k === "String" ? 6 : t.k === "bool" ? 1 : Math.max(1, t.bits / 8);
    for (const d of t.dims ?? []) n *= d;
    return n;
  }

  private sizeofOf(e: Extract<Expr, { k: "sizeof" }>): number | null {
    if (e.type) return this.sizeBytes(this.vt(e.type));
    if (e.e && e.e.k === "id") {
      const v = this.lookup(e.e.name);
      if (v) return this.sizeBytes(v.type);
    }
    return null;
  }

  // ───────── expressions

  private raw(c: string, t: VType): Typed {
    return { c, t };
  }

  /** JS boolean expression for a C condition. */
  private cond(e: Expr): string {
    switch (e.k) {
      case "bin":
        if (e.op === "&&") return `(${this.cond(e.l)} && ${this.cond(e.r)})`;
        if (e.op === "||") return `(${this.cond(e.l)} || ${this.cond(e.r)})`;
        if (["==", "!=", "<", ">", "<=", ">="].includes(e.op)) return this.compare(e);
        break;
      case "un":
        if (e.op === "!") return `(!${this.cond(e.e)})`;
        break;
      default:
        break;
    }
    const x = this.expr(e);
    if (x.t.k === "String") return `(${x.c}.length > 0)`;
    return `(${x.c} !== 0)`;
  }

  private compare(e: Extract<Expr, { k: "bin" }>): string {
    const a = this.expr(e.l);
    const b = this.expr(e.r);
    const op = e.op === "==" ? "===" : e.op === "!=" ? "!==" : e.op;
    if (a.t.k === "String" || b.t.k === "String") {
      if (a.t.k !== b.t.k && !(a.t.dims || b.t.dims)) {
        // String vs char/number comparisons are compared textually
      }
      return `(${this.asString(a)} ${op} ${this.asString(b)})`;
    }
    if (a.t.dims || b.t.dims) throw new CompileError("Arrays cannot be compared.", e.line);
    return `(${a.c} ${op} ${b.c})`;
  }

  private asString(x: Typed): string {
    if (x.t.k === "String" && !x.t.dims) return x.c;
    return `R.s(${x.c}, "${this.kindTag(x.t)}")`;
  }

  private expr(e: Expr): Typed {
    switch (e.k) {
      case "num": {
        if (e.isFloat) return this.raw(String(e.v), T_FLOAT);
        let t: VType;
        const maxInt = 2 ** (this.intBits - 1) - 1;
        const maxUInt = 2 ** this.intBits - 1;
        if (e.suffix.includes("l")) t = { k: "int", bits: 32, signed: !e.suffix.includes("u") };
        else if (e.suffix.includes("u")) t = { k: "int", bits: e.v > maxUInt ? 32 : this.intBits, signed: false };
        else if (e.v <= maxInt) t = { k: "int", bits: this.intBits, signed: true };
        else if (e.hex && e.v <= maxUInt) t = { k: "int", bits: this.intBits, signed: false };
        else if (e.v <= 2 ** 31 - 1) t = { k: "int", bits: 32, signed: true };
        else if (e.v <= 2 ** 32 - 1) t = { k: "int", bits: 32, signed: false };
        else t = { k: "int", bits: 64, signed: true };
        return this.raw(String(e.v), t);
      }
      case "str":
        return this.raw(JSON.stringify(e.v), T_STRING);
      case "chr":
        return this.raw(String(e.v), { k: "char", bits: 8, signed: true });
      case "id":
        return this.ident(e);
      case "un":
        return this.unary(e);
      case "bin":
        return this.binary(e);
      case "pre":
      case "post":
        return this.incdec(e, true);
      case "assign":
        return this.assign(e);
      case "cond": {
        const a = this.expr(e.a);
        const b = this.expr(e.b);
        let t: VType;
        if (a.t.k === "String" || b.t.k === "String") t = T_STRING;
        else if (a.t.k === "float" || b.t.k === "float") t = T_FLOAT;
        else if (isNum(a.t) && isNum(b.t)) t = this.common(a.t, b.t);
        else t = a.t;
        return this.raw(`(${this.cond(e.c)} ? ${this.conv(a, t, e.line)} : ${this.conv(b, t, e.line)})`, t);
      }
      case "call":
        return this.call(e);
      case "mcall":
        return this.mcall(e);
      case "idx": {
        const base = this.expr(e.e);
        const i = this.expr(e.i);
        if (base.t.k === "String" && !base.t.dims) return this.raw(`R.chAt(${base.c}, ${i.c})`, { k: "char", bits: 8, signed: true });
        if (!base.t.dims) throw new CompileError("This value is not an array.", e.line);
        const rest = base.t.dims.slice(1);
        const et: VType = rest.length ? { ...this.elem(base.t), dims: rest } : this.elem(base.t);
        return this.raw(`(${base.c}[${i.c}] ?? ${rest.length ? "R.Z" : "0"})`, et);
      }
      case "cast": {
        const x = this.expr(e.e);
        const to = this.vt(e.type);
        if (to.k === "void") throw new CompileError("Cannot cast to void.", e.line);
        if (to.k === "String") return this.raw(this.asString(x), T_STRING);
        return this.raw(this.conv(x, to, e.line), to);
      }
      case "sizeof": {
        const v = this.sizeofOf(e);
        if (v === null) throw new CompileError("Unsupported sizeof expression.", e.line);
        return this.raw(String(v), { k: "int", bits: this.intBits, signed: false });
      }
      case "list":
        throw new CompileError("An initializer list is only allowed in a declaration.", e.line);
    }
  }

  private ident(e: Extract<Expr, { k: "id" }>): Typed {
    const v = this.lookup(e.name);
    if (v) {
      if (v.constVal !== undefined && !v.type.dims) return this.raw(v.js, v.type);
      return this.raw(v.js, v.type);
    }
    const c = CONSTS[e.name];
    if (c !== undefined) return this.raw(String(c.v), c.float ? T_FLOAT : { k: "int", bits: this.intBits, signed: true });
    if (e.name in this.board.constants) return this.raw(String(this.board.constants[e.name]), { k: "int", bits: this.intBits, signed: true });
    if (e.name === "true") return this.raw("1", T_BOOL);
    if (e.name === "false") return this.raw("0", T_BOOL);
    const f = this.funcs.get(e.name);
    if (f) return this.raw(f.js, T_FN);
    throw new CompileError(`"${e.name}" was not declared in this scope.`, e.line);
  }

  private unary(e: Extract<Expr, { k: "un" }>): Typed {
    if (e.op === "!") return this.raw(`(${this.cond(e)} ? 1 : 0)`, T_BOOL);
    const x = this.expr(e.e);
    if (!isNum(x.t) && x.t.k !== "float") throw new CompileError(`Operator "${e.op}" needs a number.`, e.line);
    if (x.t.k === "float") {
      if (e.op === "~") throw new CompileError('Operator "~" needs an integer.', e.line);
      return this.raw(e.op === "-" ? `(-${x.c})` : x.c, T_FLOAT);
    }
    const t = this.promote(x.t);
    if (e.op === "+") return this.raw(x.c, t);
    if (e.op === "-") return this.raw(this.wrap(t, `-${x.c}`), t);
    return this.raw(this.wrap(t, `~${x.c}`), t);
  }

  private binary(e: Extract<Expr, { k: "bin" }>): Typed {
    const op = e.op;
    if (op === ",") {
      const l = this.exprDiscard(e.l);
      const r = this.expr(e.r);
      return this.raw(`(${l}, ${r.c})`, r.t);
    }
    if (op === "&&" || op === "||" || ["==", "!=", "<", ">", "<=", ">="].includes(op)) {
      return this.raw(`(${this.cond(e)} ? 1 : 0)`, T_BOOL);
    }
    const a = this.expr(e.l);
    const b = this.expr(e.r);
    if (op === "+" && (a.t.k === "String" || b.t.k === "String") && !a.t.dims && !b.t.dims) {
      return this.raw(`(${this.asString(a)} + ${this.asString(b)})`, T_STRING);
    }
    for (const x of [a, b]) {
      if (!isNum(x.t) && x.t.k !== "float") throw new CompileError(`Operator "${op}" needs numbers.`, e.line);
    }
    return this.arith(op, a, b, e.line);
  }

  private arith(op: string, a: Typed, b: Typed, line: number): Typed {
    if (a.t.k === "float" || b.t.k === "float") {
      switch (op) {
        case "+":
        case "-":
        case "*":
        case "/":
          return this.raw(`(${a.c} ${op} ${b.c})`, T_FLOAT);
        case "%":
          return this.raw(`(${a.c} % ${b.c})`, T_FLOAT);
        default:
          throw new CompileError(`Operator "${op}" needs integers.`, line);
      }
    }
    if (op === "<<" || op === ">>") {
      const t = this.promote(a.t);
      if (op === "<<") return this.raw(this.wrap(t, t.bits > 32 ? `${a.c} * 2 ** ${b.c}` : `${a.c} << ${b.c}`), t);
      if (t.bits > 32) return this.raw(`Math.floor(${a.c} / 2 ** ${b.c})`, t);
      return this.raw(t.signed ? `(${a.c} >> ${b.c})` : `(${a.c} >>> ${b.c})`, t);
    }
    const t = this.common(a.t, b.t);
    switch (op) {
      case "+":
      case "-":
        return this.raw(this.wrap(t, `${a.c} ${op} ${b.c}`), t);
      case "*":
        if (t.bits === 32) return this.raw(this.wrap(t, `Math.imul(${a.c}, ${b.c})`), t);
        return this.raw(this.wrap(t, `${a.c} * ${b.c}`), t);
      case "/":
        return this.raw(this.wrap(t, `R.div(${a.c}, ${b.c})`), t);
      case "%":
        return this.raw(`R.mod(${a.c}, ${b.c})`, t);
      case "&":
      case "|":
      case "^":
        return this.raw(this.wrap(t, `${a.c} ${op} ${b.c}`), t);
      default:
        throw new CompileError(`Unsupported operator "${op}".`, line);
    }
  }

  // lvalues -----------------------------------------------------

  private isLvalue(e: Expr): boolean {
    return e.k === "id" || (e.k === "idx" && this.isLvalue(e.e));
  }

  /** Evaluate an lvalue once: returns setup code (temps) and the target code / type. */
  private lvalue(e: Expr): { pre: string; target: string; type: VType } {
    if (e.k === "id") {
      const v = this.lookup(e.name);
      if (!v) throw new CompileError(`"${e.name}" was not declared in this scope.`, e.line);
      if (v.constVal !== undefined && v.js === String(v.constVal)) throw new CompileError(`"${e.name}" is a constant.`, e.line);
      if (v.type.dims) throw new CompileError(`Array "${e.name}" cannot be assigned as a whole.`, e.line);
      return { pre: "", target: v.js, type: v.type };
    }
    if (e.k === "idx") {
      const base = this.lvalueBase(e.e);
      const i = this.expr(e.i);
      if (!base.type.dims) {
        if (base.type.k === "String") throw new CompileError("String characters cannot be assigned by index.", e.line);
        throw new CompileError("This value is not an array.", e.line);
      }
      const arrTmp = this.tmp();
      const idxTmp = this.tmp();
      const rest = base.type.dims.slice(1);
      if (rest.length) throw new CompileError("Assign to a single array element.", e.line);
      return {
        pre: `${arrTmp} = ${base.code}, ${idxTmp} = ${i.c}, `,
        target: `${arrTmp}[${idxTmp}]`,
        type: this.elem(base.type),
      };
    }
    throw new CompileError("The left side of an assignment must be a variable or array element.", e.line);
  }

  private lvalueBase(e: Expr): { code: string; type: VType } {
    const x = this.expr(e);
    return { code: x.c, type: x.t };
  }

  private assign(e: Extract<Expr, { k: "assign" }>): Typed {
    // objects / strings
    const lv = this.lvalue(e.l);
    const rhs = this.expr(e.r);
    const t = lv.type;
    if (e.op === "=") {
      if (t.k === "Servo" || t.k === "LiquidCrystal") throw new CompileError("Objects cannot be assigned.", e.line);
      return this.raw(`(${lv.pre}${lv.target} = ${this.conv(rhs, t, e.line)})`, t);
    }
    const bop = e.op.slice(0, -1);
    if (t.k === "String") {
      if (bop !== "+") throw new CompileError(`Operator "${e.op}" cannot be used on a String.`, e.line);
      return this.raw(`(${lv.pre}${lv.target} = ${lv.target} + ${this.asString(rhs)})`, t);
    }
    if (!isNum(t) && t.k !== "float") throw new CompileError(`Operator "${e.op}" needs a number.`, e.line);
    if (!isNum(rhs.t) && rhs.t.k !== "float") throw new CompileError(`Operator "${e.op}" needs a number.`, e.line);
    const cur = this.raw(lv.target, t);
    const r = this.arith(bop, cur, rhs, e.line);
    return this.raw(`(${lv.pre}${lv.target} = ${this.conv(r, t, e.line)})`, t);
  }

  private incdec(e: Extract<Expr, { k: "pre" | "post" }>, wantValue: boolean): Typed {
    const lv = this.lvalue(e.e);
    const t = lv.type;
    if (!isNum(t) && t.k !== "float") throw new CompileError(`Operator "${e.op}" needs a number.`, e.line);
    const one = this.raw("1", { k: "int", bits: this.intBits, signed: true });
    const r = this.arith(e.op === "++" ? "+" : "-", this.raw(lv.target, t), one, e.line);
    const newVal = this.conv(r, t, e.line);
    if (e.k === "pre" || !wantValue) return this.raw(`(${lv.pre}${lv.target} = ${newVal})`, t);
    const old = this.tmp();
    return this.raw(`(${lv.pre}${old} = ${lv.target}, ${lv.target} = ${newVal}, ${old})`, t);
  }

  /** Expression whose value is discarded (statement context). */
  private exprDiscard(e: Expr): string {
    if (e.k === "post") return this.incdec(e, false).c;
    if (e.k === "bin" && e.op === ",") return `(${this.exprDiscard(e.l)}, ${this.exprDiscard(e.r)})`;
    return this.expr(e).c;
  }

  // calls -------------------------------------------------------

  private call(e: Extract<Expr, { k: "call" }>): Typed {
    const user = this.funcs.get(e.name);
    if (user && !this.lookup(e.name)) {
      if (e.args.length !== user.params.length) {
        throw new CompileError(`"${e.name}" expects ${user.params.length} argument(s) but got ${e.args.length}.`, e.line);
      }
      const args = e.args.map((a, i) => {
        const p = user.params[i]!;
        const x = this.expr(a);
        if (p.isArray) {
          if (!x.t.dims && x.t.k !== "String") throw new CompileError(`Argument ${i + 1} of "${e.name}" must be an array.`, e.line);
          return x.t.k === "String" ? x.c : x.c;
        }
        if (p.type.k === "String" && x.t.dims && x.t.k === "char") return `R.cstr(${x.c})`;
        return this.conv(x, p.type, e.line);
      });
      return this.raw(`(yield* ${user.js}(${args.join(", ")}))`, user.ret);
    }
    return this.builtinCall(e);
  }

  private num(e: Expr): Typed {
    const x = this.expr(e);
    if (!isNum(x.t) && x.t.k !== "float") throw new CompileError("A number is required here.", (e as { line: number }).line);
    return x;
  }

  private builtinCall(e: Extract<Expr, { k: "call" }>): Typed {
    const { name, args, line } = e;
    const INT: VType = { k: "int", bits: this.intBits, signed: true };
    const LONG: VType = { k: "int", bits: 32, signed: true };
    const ULONG: VType = { k: "int", bits: 32, signed: false };
    const n = (min: number, max = min): void => {
      if (args.length < min || args.length > max) {
        throw new CompileError(`"${name}" expects ${min === max ? min : `${min}–${max}`} argument(s) but got ${args.length}.`, line);
      }
    };
    const a = (i: number): string => this.num(args[i]!).c;
    const nums = (): string => args.map((_x, i) => a(i)).join(", ");
    const gen = (code: string, t: VType): Typed => this.raw(code, t);
    switch (name) {
      case "pinMode":
        n(2);
        return gen(`R.pinMode(${nums()})`, T_VOID);
      case "digitalWrite":
        n(2);
        return gen(`R.digitalWrite(${nums()})`, T_VOID);
      case "digitalRead":
        n(1);
        return gen(`(yield* R.digitalRead(${nums()}))`, INT);
      case "analogRead":
        n(1);
        return gen(`(yield* R.analogRead(${nums()}))`, INT);
      case "analogWrite":
      case "ledcWrite":
        n(2);
        return gen(`R.analogWrite(${nums()})`, T_VOID);
      case "analogReference":
      case "analogReadResolution":
      case "analogWriteResolution":
      case "analogSetAttenuation":
      case "analogSetWidth":
      case "interrupts":
      case "noInterrupts":
      case "sei":
      case "cli":
      case "randomSeed":
        if (name === "randomSeed") return gen(`R.randomSeed(${nums()})`, T_VOID);
        if (name === "analogReadResolution") return gen(`R.analogReadResolution(${nums()})`, T_VOID);
        return gen("0", T_VOID);
      case "tone":
        n(2, 3);
        return gen(`R.tone(${nums()})`, T_VOID);
      case "noTone":
        n(1);
        return gen(`R.noTone(${nums()})`, T_VOID);
      case "pulseIn":
      case "pulseInLong":
        n(2, 3);
        return gen(`(yield* R.pulseIn(${nums()}))`, ULONG);
      case "shiftOut":
        n(4);
        return gen(`(yield* R.shiftOut(${nums()}))`, T_VOID);
      case "shiftIn":
        n(3);
        return gen(`(yield* R.shiftIn(${nums()}))`, { k: "int", bits: 8, signed: false });
      case "delay":
        n(1);
        return gen(`(yield* R.delay(${nums()}))`, T_VOID);
      case "delayMicroseconds":
        n(1);
        return gen(`(yield* R.delayUs(${nums()}))`, T_VOID);
      case "yield":
        return gen("(yield* R.spin())", T_VOID);
      case "millis":
        n(0);
        return gen("R.millis()", ULONG);
      case "micros":
        n(0);
        return gen("R.micros()", ULONG);
      case "random":
        n(1, 2);
        return gen(`R.random(${nums()})`, LONG);
      case "map": {
        n(5);
        const t = args.map((_x, i) => this.num(args[i]!).t).some((x) => x.k === "float") ? T_FLOAT : LONG;
        return gen(t.k === "float" ? `R.mapf(${nums()})` : `R.map(${nums()})`, t);
      }
      case "constrain":
      case "min":
      case "max": {
        n(name === "constrain" ? 3 : 2);
        const xs = args.map((_x, i) => this.num(args[i]!));
        const t = xs.reduce((acc, x) => (acc ? this.common(acc, x.t) : this.promote(x.t)), null as VType | null) ?? INT;
        const cs = xs.map((x) => this.conv(x, t, line)).join(", ");
        return gen(`R.${name}(${cs})`, t);
      }
      case "abs": {
        n(1);
        const x = this.num(args[0]!);
        return gen(`Math.abs(${x.c})`, x.t.k === "float" ? T_FLOAT : this.promote(x.t));
      }
      case "sq": {
        n(1);
        const x = this.num(args[0]!);
        return x.t.k === "float" ? gen(`(${x.c} * ${x.c})`, T_FLOAT) : this.arith("*", x, x, line);
      }
      case "pow":
      case "atan2":
      case "fmod":
      case "hypot":
        n(2);
        return gen(`R.${name}(${nums()})`, T_FLOAT);
      case "sqrt":
      case "sin":
      case "cos":
      case "tan":
      case "asin":
      case "acos":
      case "atan":
      case "exp":
      case "log":
      case "log10":
      case "sinh":
      case "cosh":
      case "tanh":
      case "cbrt":
        n(1);
        return gen(`Math.${name}(${nums()})`, T_FLOAT);
      case "floor":
      case "ceil":
      case "round":
      case "trunc":
        n(1);
        return gen(`Math.${name}(${nums()})`, T_FLOAT);
      case "radians":
        n(1);
        return gen(`(${a(0)} * 0.017453292519943295)`, T_FLOAT);
      case "degrees":
        n(1);
        return gen(`(${a(0)} * 57.29577951308232)`, T_FLOAT);
      case "isnan":
        n(1);
        return gen(`(Number.isNaN(${a(0)}) ? 1 : 0)`, T_BOOL);
      case "bit":
        n(1);
        return gen(`(1 << ${a(0)})`, ULONG);
      case "lowByte":
        n(1);
        return gen(`(${a(0)} & 255)`, { k: "int", bits: 8, signed: false });
      case "highByte":
        n(1);
        return gen(`((${a(0)} >> 8) & 255)`, { k: "int", bits: 8, signed: false });
      case "bitRead":
        n(2);
        return gen(`((${a(0)} >>> ${a(1)}) & 1)`, INT);
      case "bitWrite":
      case "bitSet":
      case "bitClear": {
        const want = name === "bitWrite" ? 3 : 2;
        n(want);
        const lv = this.lvalue(args[0]!);
        const bitN = a(1);
        let val: string;
        if (name === "bitSet") val = `${lv.target} | (1 << ${bitN})`;
        else if (name === "bitClear") val = `${lv.target} & ~(1 << ${bitN})`;
        else val = `(${a(2)} ? (${lv.target} | (1 << ${bitN})) : (${lv.target} & ~(1 << ${bitN})))`;
        return gen(`(${lv.pre}${lv.target} = ${this.wrap(lv.type, val)})`, T_VOID);
      }
      case "digitalPinToInterrupt":
        n(1);
        return gen(a(0), INT);
      case "attachInterrupt": {
        n(3);
        const fnArg = args[1]!;
        if (fnArg.k !== "id" || !this.funcs.has(fnArg.name)) throw new CompileError("attachInterrupt needs the name of a function.", line);
        return gen(`R.attachInterrupt(${a(0)}, ${this.funcs.get(fnArg.name)!.js}, ${a(2)})`, T_VOID);
      }
      case "detachInterrupt":
        n(1);
        return gen(`R.detachInterrupt(${a(0)})`, T_VOID);
      case "isDigit":
      case "isAlpha":
      case "isAlphaNumeric":
      case "isSpace":
      case "isUpperCase":
      case "isLowerCase":
      case "isPunct":
      case "isAscii":
      case "isHexadecimalDigit":
        n(1);
        return gen(`R.${name}(${a(0)})`, T_BOOL);
      case "toupper":
      case "toLowerCase":
      case "tolower":
      case "toUpperCase":
        n(1);
        return gen(`R.${name === "toupper" || name === "toUpperCase" ? "toUpper" : "toLower"}(${a(0)})`, INT);
      case "F":
      case "PSTR":
      case "String": {
        n(1);
        const x = this.expr(args[0]!);
        return gen(this.asString(x), T_STRING);
      }
      case "strlen": {
        n(1);
        const x = this.expr(args[0]!);
        return gen(x.t.dims ? `R.cstr(${x.c}).length` : `${x.c}.length`, INT);
      }
      case "strcmp": {
        n(2);
        const x = this.cstrArg(args[0]!);
        const y = this.cstrArg(args[1]!);
        return gen(`R.strcmp(${x}, ${y})`, INT);
      }
      case "atoi":
      case "atol":
      case "atof": {
        n(1);
        const x = this.cstrArg(args[0]!);
        return gen(name === "atof" ? `R.toFloat(${x})` : `R.toInt(${x})`, name === "atof" ? T_FLOAT : INT);
      }
      case "strcpy":
      case "strcat": {
        n(2);
        const dst = this.expr(args[0]!);
        if (!dst.t.dims || dst.t.k !== "char") throw new CompileError(`${name} needs a char array as destination.`, line);
        return gen(`R.${name}(${dst.c}, ${this.cstrArg(args[1]!)})`, T_VOID);
      }
      case "memset": {
        n(3);
        const dst = this.expr(args[0]!);
        return gen(`${dst.c}.fill(${a(1)}, 0, ${a(2)})`, T_VOID);
      }
      case "sprintf":
      case "snprintf": {
        const off = name === "snprintf" ? 3 : 2;
        if (args.length < off) throw new CompileError(`"${name}" needs a destination and a format string.`, line);
        const dst = this.expr(args[0]!);
        if (!dst.t.dims || dst.t.k !== "char") throw new CompileError(`${name} needs a char array as destination.`, line);
        const fmt = this.cstrArg(args[off - 1]!);
        const rest = args.slice(off).map((x) => {
          const v = this.expr(x);
          return `[${v.t.dims && v.t.k === "char" ? `R.cstr(${v.c})` : v.c}, "${this.kindTag(v.t)}"]`;
        });
        return gen(`R.sprintf(${dst.c}, ${name === "snprintf" ? a(1) : "-1"}, ${fmt}, [${rest.join(", ")}])`, INT);
      }
      case "dtostrf": {
        n(4);
        const dst = this.expr(args[3]!);
        if (!dst.t.dims || dst.t.k !== "char") throw new CompileError("dtostrf needs a char array as destination.", line);
        return gen(`R.dtostrf(${a(0)}, ${a(1)}, ${a(2)}, ${dst.c})`, T_VOID);
      }
      case "printf": {
        if (args.length < 1) throw new CompileError("printf needs a format string.", line);
        return this.serialPrintf(args, line);
      }
      default:
        throw new CompileError(`Unknown function "${name}".`, line);
    }
  }

  private cstrArg(e: Expr): string {
    const x = this.expr(e);
    if (x.t.dims && x.t.k === "char") return `R.cstr(${x.c})`;
    if (x.t.k !== "String") throw new CompileError("A text value is required here.", (e as { line: number }).line);
    return x.c;
  }

  private serialPrintf(args: Expr[], line: number): Typed {
    const fmt = this.cstrArg(args[0]!);
    const rest = args.slice(1).map((x) => {
      const v = this.expr(x);
      return `[${v.t.dims && v.t.k === "char" ? `R.cstr(${v.c})` : v.c}, "${this.kindTag(v.t)}"]`;
    });
    void line;
    return this.raw(`R.printf(${fmt}, [${rest.join(", ")}])`, T_VOID);
  }

  private mcall(e: Extract<Expr, { k: "mcall" }>): Typed {
    const { obj, name, args, line } = e;
    const INT: VType = { k: "int", bits: this.intBits, signed: true };
    const check = (min: number, max = min): void => {
      if (args.length < min || args.length > max) {
        throw new CompileError(`".${name}" expects ${min === max ? min : `${min}–${max}`} argument(s) but got ${args.length}.`, line);
      }
    };
    // Serial
    if (obj.k === "id" && /^Serial\d?$/.test(obj.name) && !this.lookup(obj.name)) return this.serialCall(name, args, line);
    if (obj.k === "id" && obj.name === "ESP" && !this.lookup("ESP")) {
      if (name === "restart") return this.raw("R.restart()", T_VOID);
      return this.raw("0", INT);
    }
    const o = this.expr(obj);
    const a = (i: number): string => this.num(args[i]!).c;
    switch (o.t.k) {
      case "Servo": {
        switch (name) {
          case "attach":
            check(1, 3);
            return this.raw(`${o.c}.attach(${a(0)})`, T_VOID);
          case "detach":
            check(0);
            return this.raw(`${o.c}.detach()`, T_VOID);
          case "write":
            check(1);
            return this.raw(`${o.c}.write(${a(0)})`, T_VOID);
          case "writeMicroseconds":
            check(1);
            return this.raw(`${o.c}.writeMicroseconds(${a(0)})`, T_VOID);
          case "read":
            check(0);
            return this.raw(`${o.c}.read()`, INT);
          case "attached":
            check(0);
            return this.raw(`(${o.c}.attached() ? 1 : 0)`, T_BOOL);
          default:
            throw new CompileError(`Servo has no method "${name}".`, line);
        }
      }
      case "LiquidCrystal": {
        switch (name) {
          case "begin":
            check(2, 3);
            return this.raw(`(yield* ${o.c}.begin(${a(0)}, ${a(1)}))`, T_VOID);
          case "print":
          case "write": {
            check(1, 2);
            const x = this.expr(args[0]!);
            const extra = args[1] ? `, ${this.num(args[1]).c}` : "";
            return this.raw(`(yield* ${o.c}.print(${x.c}, "${name === "write" ? "c" : this.kindTag(x.t)}"${extra}))`, T_VOID);
          }
          case "setCursor":
            check(2);
            return this.raw(`(yield* ${o.c}.setCursor(${a(0)}, ${a(1)}))`, T_VOID);
          case "clear":
          case "home":
          case "display":
          case "noDisplay":
          case "cursor":
          case "noCursor":
          case "blink":
          case "noBlink":
          case "scrollDisplayLeft":
          case "scrollDisplayRight":
          case "autoscroll":
          case "noAutoscroll":
            check(0);
            return this.raw(`(yield* ${o.c}.cmd("${name}"))`, T_VOID);
          case "createChar": {
            check(2);
            const arr = this.expr(args[1]!);
            return this.raw(`(yield* ${o.c}.createChar(${a(0)}, ${arr.c}))`, T_VOID);
          }
          default:
            throw new CompileError(`LiquidCrystal has no method "${name}".`, line);
        }
      }
      case "String": {
        if (o.t.dims) throw new CompileError(`Arrays have no method "${name}".`, line);
        const inPlace = (code: string): Typed => {
          const lv = this.lvalue(obj);
          return this.raw(`(${lv.pre}${lv.target} = ${code.replaceAll("§", lv.target)})`, T_VOID);
        };
        switch (name) {
          case "length":
            check(0);
            return this.raw(`${o.c}.length`, { k: "int", bits: this.intBits, signed: false });
          case "charAt":
            check(1);
            return this.raw(`R.chAt(${o.c}, ${a(0)})`, { k: "char", bits: 8, signed: true });
          case "substring":
            check(1, 2);
            return this.raw(`R.sub(${o.c}, ${a(0)}${args[1] ? `, ${a(1)}` : ""})`, T_STRING);
          case "indexOf":
          case "lastIndexOf": {
            check(1, 2);
            const x = this.expr(args[0]!);
            return this.raw(`R.${name}(${o.c}, ${this.asString(x)}${args[1] ? `, ${a(1)}` : ""})`, INT);
          }
          case "toInt":
            check(0);
            return this.raw(`R.toInt(${o.c})`, { k: "int", bits: 32, signed: true });
          case "toFloat":
          case "toDouble":
            check(0);
            return this.raw(`R.toFloat(${o.c})`, T_FLOAT);
          case "equals":
            check(1);
            return this.raw(`(${o.c} === ${this.asString(this.expr(args[0]!))} ? 1 : 0)`, T_BOOL);
          case "equalsIgnoreCase":
            check(1);
            return this.raw(`(${o.c}.toLowerCase() === ${this.asString(this.expr(args[0]!))}.toLowerCase() ? 1 : 0)`, T_BOOL);
          case "startsWith":
            check(1);
            return this.raw(`(${o.c}.startsWith(${this.asString(this.expr(args[0]!))}) ? 1 : 0)`, T_BOOL);
          case "endsWith":
            check(1);
            return this.raw(`(${o.c}.endsWith(${this.asString(this.expr(args[0]!))}) ? 1 : 0)`, T_BOOL);
          case "compareTo":
            check(1);
            return this.raw(`R.strcmp(${o.c}, ${this.asString(this.expr(args[0]!))})`, INT);
          case "c_str":
            check(0);
            return this.raw(o.c, T_STRING);
          case "isEmpty":
            check(0);
            return this.raw(`(${o.c}.length === 0 ? 1 : 0)`, T_BOOL);
          case "toUpperCase":
            return inPlace("§.toUpperCase()");
          case "toLowerCase":
            return inPlace("§.toLowerCase()");
          case "trim":
            return inPlace("§.trim()");
          case "concat":
            check(1);
            return inPlace(`§ + ${this.asString(this.expr(args[0]!))}`);
          case "replace": {
            check(2);
            const x = this.asString(this.expr(args[0]!));
            const y = this.asString(this.expr(args[1]!));
            return inPlace(`R.repl(§, ${x}, ${y})`);
          }
          case "remove":
            check(1, 2);
            return inPlace(`R.remove(§, ${a(0)}${args[1] ? `, ${a(1)}` : ""})`);
          default:
            throw new CompileError(`String has no method "${name}".`, line);
        }
      }
      default:
        throw new CompileError(`"${name}" is not a method of this value.`, line);
    }
  }

  private serialCall(name: string, args: Expr[], line: number): Typed {
    const INT: VType = { k: "int", bits: this.intBits, signed: true };
    const a = (i: number): string => this.num(args[i]!).c;
    switch (name) {
      case "begin":
        return this.raw(`R.sBegin(${args.length ? a(0) : "9600"})`, T_VOID);
      case "end":
      case "flush":
      case "setTimeout":
      case "setDebugOutput":
        return this.raw("0", T_VOID);
      case "print":
      case "println": {
        const nl = name === "println" ? 1 : 0;
        if (args.length === 0) return this.raw(`R.sPrint("", "s", 0, ${nl})`, T_VOID);
        const x = this.expr(args[0]!);
        if (x.t.k === "Servo" || x.t.k === "LiquidCrystal") throw new CompileError("This value cannot be printed.", line);
        const tag = this.kindTag(x.t);
        const val = tag === "a" ? `R.cstr(${x.c})` : x.c;
        const arg = args[1] ? a(1) : "-1";
        return this.raw(`R.sPrint(${val}, "${tag === "a" ? "s" : tag}", ${arg}, ${nl})`, T_VOID);
      }
      case "write":
        return this.raw(`R.sWrite(${a(0)})`, T_VOID);
      case "printf":
        return this.serialPrintf(args, line);
      case "available":
        return this.raw("R.sAvailable()", INT);
      case "read":
        return this.raw("R.sRead()", INT);
      case "peek":
        return this.raw("R.sPeek()", INT);
      case "parseInt":
        return this.raw("R.sParseInt()", { k: "int", bits: 32, signed: true });
      case "parseFloat":
        return this.raw("R.sParseFloat()", T_FLOAT);
      case "readString":
        return this.raw("R.sReadString()", T_STRING);
      case "readStringUntil":
        return this.raw(`R.sReadStringUntil(${a(0)})`, T_STRING);
      default:
        throw new CompileError(`Serial has no method "${name}".`, line);
    }
  }

  // ───────── statements

  private stmt(s: Stmt): string {
    switch (s.k) {
      case "empty":
        return ";";
      case "block": {
        this.push();
        const body = s.body.map((x) => this.stmt(x)).join("\n");
        this.pop();
        return `{\n${body}\n}`;
      }
      case "expr":
        return `${this.exprDiscard(s.e)};`;
      case "decl":
        return this.localDecl(s);
      case "if": {
        const c = this.cond(s.c);
        const t = this.body(s.t);
        const f = s.f ? ` else ${this.body(s.f)}` : "";
        return `if (${c}) ${t}${f}`;
      }
      case "while":
        return `while (${this.cond(s.c)}) {\nif (R.tk()) yield* R.spin();\n${this.bodyInner(s.body)}\n}`;
      case "do":
        return `do {\nif (R.tk()) yield* R.spin();\n${this.bodyInner(s.body)}\n} while (${this.cond(s.c)});`;
      case "for": {
        this.push();
        const init = s.init ? this.forInit(s.init) : "";
        const c = s.cond ? this.cond(s.cond) : "";
        const step = s.step ? this.exprDiscard(s.step) : "";
        const body = this.bodyInner(s.body);
        this.pop();
        return `for (${init}; ${c}; ${step}) {\nif (R.tk()) yield* R.spin();\n${body}\n}`;
      }
      case "switch": {
        const x = this.num(s.e);
        const cases = s.cases
          .map((cs) => {
            const label = cs.match ? `case ${this.expr(cs.match).c}:` : "default:";
            this.push();
            const body = cs.body.map((b) => this.stmt(b)).join("\n");
            this.pop();
            return `${label} {\n${body}\n}`;
          })
          .join("\n");
        return `switch (${x.c}) {\n${cases}\n}`;
      }
      case "break":
        return "break;";
      case "continue":
        return "continue;";
      case "return": {
        if (this.curRet.k === "void") {
          if (s.e) throw new CompileError("A void function cannot return a value.", s.line);
          return "return;";
        }
        if (!s.e) throw new CompileError("This function must return a value.", s.line);
        return `return ${this.conv(this.expr(s.e), this.curRet, s.line)};`;
      }
    }
  }

  private body(s: Stmt): string {
    if (s.k === "block") return this.stmt(s);
    this.push();
    const c = this.stmt(s);
    this.pop();
    return `{ ${c} }`;
  }

  private bodyInner(s: Stmt): string {
    if (s.k === "block") {
      this.push();
      const body = s.body.map((x) => this.stmt(x)).join("\n");
      this.pop();
      return body;
    }
    this.push();
    const c = this.stmt(s);
    this.pop();
    return c;
  }

  private forInit(s: Stmt): string {
    if (s.k === "decl") return this.localDecl(s).replace(/;\s*$/, "");
    if (s.k === "expr") return this.exprDiscard(s.e);
    return "";
  }

  private arrayElemKind(t: VType): string {
    if (t.k === "float") return "f64";
    if (t.k === "bool") return "u8";
    if (t.bits > 32) return "f64";
    return `${t.signed ? "i" : "u"}${t.bits}`;
  }

  /** Build code that creates the value for a declarator. Returns code or null when uninitialised scalar. */
  private declValue(ts: TypeSpec, d: Declarator): { type: VType; code: string } {
    const base = this.vt(ts);
    if (base.k === "void") throw new CompileError("A variable cannot have type void.", d.line);
    if (d.dims.length > 0) {
      if (base.k === "Servo" || base.k === "LiquidCrystal" || base.k === "String") {
        throw new CompileError("Arrays of this type are not supported.", d.line);
      }
      const dims: number[] = [];
      let init = d.init;
      for (let i = 0; i < d.dims.length; i++) {
        const de = d.dims[i];
        if (de) {
          const v = this.constEval(de);
          if (v === null || v < 0 || !Number.isFinite(v)) throw new CompileError("Array size must be a constant.", d.line);
          dims.push(v);
        } else {
          if (!init) throw new CompileError("Array size is missing.", d.line);
          if (init.k === "list") dims.push(init.items.length);
          else if (init.k === "str") dims.push(init.v.length + 1);
          else throw new CompileError("Cannot infer the array size.", d.line);
        }
      }
      const type: VType = { ...base, dims };
      let initCode = "null";
      if (init) {
        if (init.k === "str" && base.k === "char") {
          initCode = JSON.stringify([...init.v].map((c) => c.charCodeAt(0)).concat([0]));
        } else if (init.k === "list") {
          initCode = this.listInit(init, base, dims.length);
        } else throw new CompileError("Bad array initializer.", d.line);
        init = null;
      }
      return { type, code: `R.arr("${this.arrayElemKind(base)}", ${JSON.stringify(dims)}, ${initCode})` };
    }
    switch (base.k) {
      case "Servo":
        return { type: base, code: "new R.Servo()" };
      case "LiquidCrystal": {
        const args = (d.ctorArgs ?? []).map((x) => this.num(x).c);
        return { type: base, code: `new R.LiquidCrystal(${args.join(", ")})` };
      }
      case "String": {
        if (d.ctorArgs && d.ctorArgs.length) return { type: base, code: this.asString(this.expr(d.ctorArgs[0]!)) };
        if (!d.init) return { type: base, code: '""' };
        if (d.init.k === "list") throw new CompileError("Bad initializer for a String.", d.line);
        return { type: base, code: this.conv(this.expr(d.init), base, d.line) };
      }
      default: {
        if (!d.init) return { type: base, code: "0" };
        if (d.init.k === "list") throw new CompileError("Bad initializer for a scalar.", d.line);
        return { type: base, code: this.conv(this.expr(d.init), base, d.line) };
      }
    }
  }

  private listInit(l: Extract<Expr, { k: "list" }>, elem: VType, depth: number): string {
    const parts = l.items.map((it) => {
      if (it.k === "list") return this.listInit(it, elem, depth - 1);
      const x = this.expr(it);
      return this.conv(x, this.elem(elem), l.line);
    });
    return `[${parts.join(", ")}]`;
  }

  private localDecl(s: Extract<Stmt, { k: "decl" }>): string {
    const out: string[] = [];
    for (const d of s.vars) {
      const { type, code } = this.declValue(s.ts, d);
      if (s.ts.isStatic) {
        // function-level static: hoisted, initialised once
        const sname = `s${++this.staticN}_${d.name}`;
        this.statics.push(`let ${sname} = ${code};`);
        const info = this.declare(d.name, type, d.line);
        this.scopes[this.scopes.length - 1]!.set(d.name, { ...info, js: sname });
        continue;
      }
      let cv: number | undefined;
      if (s.ts.isConst && !type.dims && d.init && (type.k === "int" || type.k === "char")) {
        const v = this.constEval(d.init);
        if (v !== null && Number.isInteger(v)) cv = v;
      }
      const info = this.declare(d.name, type, d.line, cv);
      out.push(`let ${info.js} = ${code};`);
    }
    return out.join(" ");
  }

  // ───────── program

  compile(prog: Program): string {
    // pass 1: enums, function signatures
    for (const it of prog.items) {
      if (it.k === "enum") {
        let next = 0;
        for (const m of it.items) {
          const v = m.value ? this.constEval(m.value) : next;
          if (v === null) throw new CompileError("Enum values must be constants.", it.line);
          next = v + 1;
          this.declare(m.name, { k: "int", bits: this.intBits, signed: true }, it.line, v);
          this.scopes[0]!.get(m.name)!.js = String(v);
        }
      }
      if (it.k === "func") {
        const sig: FuncInfo = {
          js: `f_${it.name}`,
          ret: this.vt(it.ret),
          params: it.params.map((p) => ({ type: this.paramType(p), isArray: p.isArray })),
        };
        const prev = this.funcs.get(it.name);
        if (prev && it.body === null) continue;
        this.funcs.set(it.name, sig);
      }
    }
    if (!this.funcs.has("setup")) throw new CompileError("The sketch must define void setup().", 1);
    if (!this.funcs.has("loop")) throw new CompileError("The sketch must define void loop().", 1);

    const globals: string[] = [];
    const init: string[] = [];
    const fns: string[] = [];
    for (const it of prog.items) {
      if (it.k === "decl") {
        for (const d of it.vars) {
          const { type, code } = this.declValue(it.ts, d);
          let cv: number | undefined;
          if (it.ts.isConst && !type.dims && d.init && (type.k === "int" || type.k === "char")) {
            const v = this.constEval(d.init);
            if (v !== null && Number.isInteger(v)) cv = v;
          }
          const info = this.declare(d.name, type, d.line, cv);
          globals.push(`let ${info.js};`);
          init.push(`${info.js} = ${code};`);
        }
      } else if (it.k === "func" && it.body) {
        fns.push(this.func(it));
      }
    }
    const tempsDecl = this.temps.length ? `let ${this.temps.join(", ")};\n` : "";
    void tempsDecl;
    return [
      '"use strict";',
      ...globals,
      ...this.statics,
      `function* $init() {\n${this.initTemps(init)}\n}`,
      ...fns,
      "return { init: $init, setup: f_setup, loop: f_loop };",
    ].join("\n");
  }

  private initTemps(init: string[]): string {
    return init.join("\n");
  }

  private paramType(p: Param): VType {
    const t = this.vt(p.ts);
    if (p.ts.base === "void") throw new CompileError("A parameter cannot have type void.", 0);
    return p.isArray ? { ...t, dims: [0] } : t;
  }

  private func(f: Extract<TopLevel, { k: "func" }>): string {
    const info = this.funcs.get(f.name)!;
    this.temps = [];
    this.curFn = f.name;
    this.curRet = info.ret;
    this.push();
    const names: string[] = [];
    f.params.forEach((p, i) => {
      if (!p.name) throw new CompileError("Parameters of a function definition need names.", f.line);
      const v = this.declare(p.name, info.params[i]!.type, f.line);
      names.push(v.js);
    });
    const body = f.body!.map((s) => this.stmt(s)).join("\n");
    this.pop();
    const temps = this.temps.length ? `let ${this.temps.join(", ")};\n` : "";
    const tail = info.ret.k === "void" ? "" : `\nreturn ${info.ret.k === "String" ? '""' : "0"};`;
    return `function* ${info.js}(${names.join(", ")}) {\n${temps}${body}${tail}\n}`;
  }
}

const CONSTS: Record<string, { v: number; float?: boolean }> = {
  HIGH: { v: 1 },
  LOW: { v: 0 },
  INPUT: { v: 0 },
  OUTPUT: { v: 1 },
  INPUT_PULLUP: { v: 2 },
  CHANGE: { v: 1 },
  RISING: { v: 2 },
  FALLING: { v: 3 },
  LSBFIRST: { v: 0 },
  MSBFIRST: { v: 1 },
  DEC: { v: 10 },
  HEX: { v: 16 },
  OCT: { v: 8 },
  BIN: { v: 2 },
  NULL: { v: 0 },
  PI: { v: Math.PI, float: true },
  HALF_PI: { v: Math.PI / 2, float: true },
  TWO_PI: { v: Math.PI * 2, float: true },
  DEG_TO_RAD: { v: Math.PI / 180, float: true },
  RAD_TO_DEG: { v: 180 / Math.PI, float: true },
  EULER: { v: Math.E, float: true },
  DEFAULT: { v: 0 },
  INTERNAL: { v: 3 },
  EXTERNAL: { v: 0 },
};

// ───────────────────────── public API ─────────────────────────

export function compileSketch(source: string, boardKind: string): CompileResult {
  const board = boardFor(boardKind);
  if (!board) {
    return { ok: false, js: "", errors: [{ line: 1, col: 1, message: `${boardKind} is not a programmable board.` }], includes: [], board: boardKind };
  }
  try {
    const { tokens, includes } = lex(source, board.predefined);
    const prog = parseProgram(tokens, board.intBits);
    const gen = new Gen(board);
    const js = gen.compile(prog);
    return { ok: true, js, errors: [], includes, board: boardKind };
  } catch (e) {
    if (e instanceof CompileError) {
      return { ok: false, js: "", errors: [{ line: e.line, col: e.col, message: e.message }], includes: [], board: boardKind };
    }
    throw e;
  }
}
