/**
 * Tokenizer + tiny C preprocessor for the Arduino-C++ subset.
 * Handles comments, #define (object- and function-like), #include (recorded), #ifdef/#ifndef/#if/#elif/#else/#endif.
 */

export class CompileError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly col = 1,
  ) {
    super(message);
  }
}

export type TokKind = "id" | "num" | "str" | "chr" | "op" | "eof";

export interface Token {
  t: TokKind;
  /** identifier text, operator text, or decoded string contents */
  v: string;
  /** numeric value for num / chr */
  n: number;
  isFloat: boolean;
  /** literal suffix (u, l, ul, f …) lower-cased */
  suffix: string;
  hex: boolean;
  line: number;
  col: number;
}

const mk = (t: TokKind, v: string, line: number, col: number, extra: Partial<Token> = {}): Token => ({
  t,
  v,
  n: 0,
  isFloat: false,
  suffix: "",
  hex: false,
  line,
  col,
  ...extra,
});

const OPS3 = ["<<=", ">>=", "..."];
const OPS2 = ["++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "==", "!=", "<=", ">=", "&&", "||", "<<", ">>", "->", "::"];

interface Macro {
  params: string[] | null;
  body: Token[];
}

export interface LexResult {
  tokens: Token[];
  includes: string[];
}

const isIdStart = (c: string): boolean => /[A-Za-z_]/.test(c);
const isIdChar = (c: string): boolean => /[A-Za-z0-9_]/.test(c);
const isDigit = (c: string): boolean => c >= "0" && c <= "9";

/** Raw tokenizer for a single chunk of text (no directives). */
function scanTokens(text: string, startLine: number): Token[] {
  const out: Token[] = [];
  let i = 0;
  let line = startLine;
  let lineStart = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i]!;
    if (c === "\n") {
      line++;
      i++;
      lineStart = i;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    const col = i - lineStart + 1;
    if (c === "/" && text[i + 1] === "/") {
      while (i < n && text[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < n && !(text[i] === "*" && text[i + 1] === "/")) {
        if (text[i] === "\n") {
          line++;
          lineStart = i + 1;
        }
        i++;
      }
      i += 2;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < n && isIdChar(text[j]!)) j++;
      out.push(mk("id", text.slice(i, j), line, col));
      i = j;
      continue;
    }
    if (isDigit(c) || (c === "." && isDigit(text[i + 1] ?? ""))) {
      let j = i;
      let hex = false;
      let isFloat = false;
      let value: number;
      if (c === "0" && (text[i + 1] === "x" || text[i + 1] === "X")) {
        j = i + 2;
        while (j < n && /[0-9a-fA-F]/.test(text[j]!)) j++;
        value = parseInt(text.slice(i + 2, j), 16);
        hex = true;
      } else if (c === "0" && (text[i + 1] === "b" || text[i + 1] === "B") && /[01]/.test(text[i + 2] ?? "")) {
        j = i + 2;
        while (j < n && /[01]/.test(text[j]!)) j++;
        value = parseInt(text.slice(i + 2, j), 2);
        hex = true;
      } else {
        while (j < n && isDigit(text[j]!)) j++;
        if (text[j] === "." && text[j - 1] !== undefined) {
          isFloat = true;
          j++;
          while (j < n && isDigit(text[j]!)) j++;
        }
        if ((text[j] === "e" || text[j] === "E") && /[0-9+\-]/.test(text[j + 1] ?? "")) {
          isFloat = true;
          j += 2;
          while (j < n && isDigit(text[j]!)) j++;
        }
        const raw = text.slice(i, j);
        if (!isFloat && raw.length > 1 && raw[0] === "0") value = parseInt(raw, 8);
        else value = parseFloat(raw);
      }
      let k = j;
      while (k < n && /[uUlLfF]/.test(text[k]!)) k++;
      const suffix = text.slice(j, k).toLowerCase();
      if (suffix.includes("f") && !hex) isFloat = true;
      out.push(mk("num", text.slice(i, k), line, col, { n: value, isFloat, suffix, hex }));
      i = k;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < n && text[j] !== '"') {
        if (text[j] === "\n") throw new CompileError("Unterminated string literal.", line, col);
        if (text[j] === "\\") {
          const e = text[j + 1] ?? "";
          s += unescape(e);
          j += 2;
        } else {
          s += text[j];
          j++;
        }
      }
      if (j >= n) throw new CompileError("Unterminated string literal.", line, col);
      out.push(mk("str", s, line, col));
      i = j + 1;
      continue;
    }
    if (c === "'") {
      let j = i + 1;
      let ch = "";
      if (text[j] === "\\") {
        ch = unescape(text[j + 1] ?? "");
        j += 2;
      } else {
        ch = text[j] ?? "";
        j++;
      }
      if (text[j] !== "'") throw new CompileError("Bad character literal.", line, col);
      out.push(mk("chr", ch, line, col, { n: ch.charCodeAt(0) || 0 }));
      i = j + 1;
      continue;
    }
    const three = text.slice(i, i + 3);
    const two = text.slice(i, i + 2);
    if (OPS3.includes(three)) {
      out.push(mk("op", three, line, col));
      i += 3;
      continue;
    }
    if (OPS2.includes(two)) {
      out.push(mk("op", two, line, col));
      i += 2;
      continue;
    }
    if ("+-*/%&|^~!<>=?:;,.(){}[]#".includes(c)) {
      out.push(mk("op", c, line, col));
      i++;
      continue;
    }
    throw new CompileError(`Unexpected character "${c}".`, line, col);
  }
  return out;
}

function unescape(e: string): string {
  switch (e) {
    case "n":
      return "\n";
    case "t":
      return "\t";
    case "r":
      return "\r";
    case "0":
      return "\0";
    case "\\":
      return "\\";
    case "'":
      return "'";
    case '"':
      return '"';
    case "a":
      return "\x07";
    case "b":
      return "\b";
    default:
      return e;
  }
}

/** Evaluate an `#if` expression over already macro-expanded tokens. */
function evalCondition(toks: Token[], macros: Map<string, Macro>, line: number): boolean {
  let p = 0;
  const peek = (): Token | undefined => toks[p];
  const isOp = (v: string): boolean => peek()?.t === "op" && peek()!.v === v;
  const primary = (): number => {
    const t = toks[p++];
    if (!t) throw new CompileError("Bad #if expression.", line);
    if (t.t === "num" || t.t === "chr") return t.n;
    if (t.t === "id") {
      if (t.v === "defined") {
        let paren = false;
        if (isOp("(")) {
          paren = true;
          p++;
        }
        const name = toks[p++]?.v ?? "";
        if (paren && isOp(")")) p++;
        return macros.has(name) ? 1 : 0;
      }
      return 0;
    }
    if (t.t === "op") {
      if (t.v === "(") {
        const v = orExpr();
        if (isOp(")")) p++;
        return v;
      }
      if (t.v === "!") return primary() ? 0 : 1;
      if (t.v === "-") return -primary();
    }
    throw new CompileError("Bad #if expression.", line);
  };
  const bin = (next: () => number, ops: string[], f: (op: string, a: number, b: number) => number) => (): number => {
    let v = next();
    while (peek()?.t === "op" && ops.includes(peek()!.v)) {
      const op = toks[p++]!.v;
      v = f(op, v, next());
    }
    return v;
  };
  const mul = bin(primary, ["*", "/", "%"], (o, a, b) => (o === "*" ? a * b : o === "/" ? (b ? Math.trunc(a / b) : 0) : b ? a % b : 0));
  const add = bin(mul, ["+", "-"], (o, a, b) => (o === "+" ? a + b : a - b));
  const rel = bin(add, ["<", ">", "<=", ">="], (o, a, b) => Number(o === "<" ? a < b : o === ">" ? a > b : o === "<=" ? a <= b : a >= b));
  const eq = bin(rel, ["==", "!="], (o, a, b) => Number(o === "==" ? a === b : a !== b));
  const andE = bin(eq, ["&&"], (_o, a, b) => Number(!!a && !!b));
  const orExpr: () => number = bin(andE, ["||"], (_o, a, b) => Number(!!a || !!b));
  return orExpr() !== 0;
}

function expandTokens(toks: Token[], macros: Map<string, Macro>, active: Set<string>, depth = 0): Token[] {
  if (depth > 20) throw new CompileError("Macro expansion too deep.", toks[0]?.line ?? 1);
  const out: Token[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.t !== "id") {
      out.push(t);
      continue;
    }
    const m = macros.get(t.v);
    if (!m || active.has(t.v)) {
      out.push(t);
      continue;
    }
    if (m.params === null) {
      const next = new Set(active).add(t.v);
      out.push(...expandTokens(m.body.map((b) => ({ ...b, line: t.line, col: t.col })), macros, next, depth + 1));
      continue;
    }
    // function-like macro: needs "("
    if (!(toks[i + 1]?.t === "op" && toks[i + 1]!.v === "(")) {
      out.push(t);
      continue;
    }
    let j = i + 2;
    let nest = 1;
    const args: Token[][] = [[]];
    while (j < toks.length && nest > 0) {
      const a = toks[j]!;
      if (a.t === "op" && a.v === "(") nest++;
      if (a.t === "op" && a.v === ")") {
        nest--;
        if (nest === 0) break;
      }
      if (a.t === "op" && a.v === "," && nest === 1) args.push([]);
      else args[args.length - 1]!.push(a);
      j++;
    }
    if (nest !== 0) throw new CompileError(`Unterminated call to macro ${t.v}.`, t.line, t.col);
    const subst: Token[] = [];
    for (const b of m.body) {
      const pi = b.t === "id" ? m.params.indexOf(b.v) : -1;
      if (pi >= 0) subst.push(...expandTokens(args[pi] ?? [], macros, active, depth + 1));
      else subst.push({ ...b, line: t.line, col: t.col });
    }
    const next = new Set(active).add(t.v);
    out.push(...expandTokens(subst, macros, next, depth + 1));
    i = j;
  }
  return out;
}

export function lex(source: string, predefined: Record<string, string> = {}): LexResult {
  const macros = new Map<string, Macro>();
  for (const [k, v] of Object.entries(predefined)) macros.set(k, { params: null, body: scanTokens(v, 0) });
  const includes: string[] = [];
  const raw: Token[] = [];

  // Split into logical lines only for directive detection; everything else is scanned as one text blob per run.
  const lines = source.split("\n");
  const condStack: { active: boolean; taken: boolean; parentActive: boolean }[] = [];
  const isActive = (): boolean => condStack.every((c) => c.active);
  let chunk: string[] = [];
  let chunkStart = 1;
  let inBlockComment = false;

  const flush = (): void => {
    if (chunk.length === 0) return;
    if (isActive()) raw.push(...scanTokens(chunk.join("\n"), chunkStart));
    chunk = [];
  };

  for (let ln = 0; ln < lines.length; ln++) {
    let text = lines[ln]!;
    const lineNo = ln + 1;
    const trimmed = text.trimStart();
    if (!inBlockComment && trimmed.startsWith("#")) {
      // gather continuation lines
      let full = trimmed;
      while (full.endsWith("\\") && ln + 1 < lines.length) {
        full = full.slice(0, -1) + " " + lines[++ln]!.trim();
      }
      flush();
      chunkStart = ln + 2;
      const m = /^#\s*(\w+)\s*(.*)$/.exec(full);
      if (!m) continue;
      const dir = m[1]!;
      let rest = m[2]!;
      // strip trailing // comment
      const cm = rest.indexOf("//");
      if (cm >= 0) rest = rest.slice(0, cm);
      rest = rest.trim();
      const active = isActive();
      switch (dir) {
        case "define":
          if (active) {
            const dm = /^([A-Za-z_]\w*)(\([^)]*\))?\s*(.*)$/.exec(rest);
            if (!dm) throw new CompileError("Bad #define.", lineNo);
            const params = dm[2] ? dm[2].slice(1, -1).split(",").map((s) => s.trim()).filter(Boolean) : null;
            macros.set(dm[1]!, { params, body: scanTokens(dm[3] ?? "", lineNo) });
          }
          break;
        case "undef":
          if (active) macros.delete(rest);
          break;
        case "include":
          if (active) includes.push(rest.replace(/[<>"]/g, ""));
          break;
        case "ifdef":
          condStack.push({ active: macros.has(rest), taken: macros.has(rest), parentActive: active });
          break;
        case "ifndef":
          condStack.push({ active: !macros.has(rest), taken: !macros.has(rest), parentActive: active });
          break;
        case "if": {
          const v = active ? evalCondition(expandDefined(scanTokens(rest, lineNo), macros), macros, lineNo) : false;
          condStack.push({ active: v, taken: v, parentActive: active });
          break;
        }
        case "elif": {
          const top = condStack[condStack.length - 1];
          if (!top) throw new CompileError("#elif without #if.", lineNo);
          if (top.taken || !top.parentActive) top.active = false;
          else {
            const v = evalCondition(expandDefined(scanTokens(rest, lineNo), macros), macros, lineNo);
            top.active = v;
            top.taken = v;
          }
          break;
        }
        case "else": {
          const top = condStack[condStack.length - 1];
          if (!top) throw new CompileError("#else without #if.", lineNo);
          top.active = !top.taken && top.parentActive;
          top.taken = true;
          break;
        }
        case "endif":
          if (!condStack.pop()) throw new CompileError("#endif without #if.", lineNo);
          break;
        default:
          break; // pragma, error, warning, line …
      }
      continue;
    }
    // track block comments so a '#' inside one is not a directive
    const scan = text;
    for (let i = 0; i < scan.length; i++) {
      if (!inBlockComment && scan[i] === "/" && scan[i + 1] === "*") {
        inBlockComment = true;
        i++;
      } else if (inBlockComment && scan[i] === "*" && scan[i + 1] === "/") {
        inBlockComment = false;
        i++;
      } else if (!inBlockComment && scan[i] === "/" && scan[i + 1] === "/") break;
    }
    if (chunk.length === 0) chunkStart = lineNo;
    chunk.push(text);
    text = "";
  }
  flush();
  if (condStack.length > 0) throw new CompileError("Missing #endif.", lines.length);

  const tokens = expandTokens(raw, macros, new Set());
  tokens.push(mk("eof", "", lines.length, 1));
  return { tokens, includes };
}

/** Replace `defined X` / `defined(X)` before macro expansion, so macros named in them are not expanded. */
function expandDefined(toks: Token[], macros: Map<string, Macro>): Token[] {
  const out: Token[] = [];
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i]!;
    if (t.t === "id" && t.v === "defined") {
      let j = i + 1;
      let paren = false;
      if (toks[j]?.t === "op" && toks[j]!.v === "(") {
        paren = true;
        j++;
      }
      const name = toks[j]?.v ?? "";
      if (paren) j++;
      out.push(mk("num", String(macros.has(name) ? 1 : 0), t.line, t.col, { n: macros.has(name) ? 1 : 0 }));
      i = j;
    } else out.push(t);
  }
  return expandTokens(out, macros, new Set());
}
