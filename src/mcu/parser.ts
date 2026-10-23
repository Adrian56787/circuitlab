import { CompileError, type Token } from "./lexer";

// ───────────────────────── AST ─────────────────────────

export type BaseType = "void" | "int" | "float" | "bool" | "char" | "String" | "Servo" | "LiquidCrystal";

export interface TypeSpec {
  base: BaseType;
  bits: number;
  signed: boolean;
  /** pointer depth (only `char*` is supported, mapped to String) */
  ptr: number;
  isConst: boolean;
  isStatic?: boolean;
}

export type Expr =
  | { k: "num"; v: number; isFloat: boolean; suffix: string; hex: boolean; line: number }
  | { k: "str"; v: string; line: number }
  | { k: "chr"; v: number; line: number }
  | { k: "id"; name: string; line: number }
  | { k: "bin"; op: string; l: Expr; r: Expr; line: number }
  | { k: "un"; op: string; e: Expr; line: number }
  | { k: "pre"; op: string; e: Expr; line: number }
  | { k: "post"; op: string; e: Expr; line: number }
  | { k: "assign"; op: string; l: Expr; r: Expr; line: number }
  | { k: "cond"; c: Expr; a: Expr; b: Expr; line: number }
  | { k: "call"; name: string; args: Expr[]; line: number }
  | { k: "mcall"; obj: Expr; name: string; args: Expr[]; line: number }
  | { k: "idx"; e: Expr; i: Expr; line: number }
  | { k: "cast"; type: TypeSpec; e: Expr; line: number }
  | { k: "sizeof"; type: TypeSpec | null; e: Expr | null; line: number }
  | { k: "list"; items: Expr[]; line: number };

export interface Declarator {
  name: string;
  /** array dimensions; `null` entry = inferred from initializer */
  dims: (Expr | null)[];
  init: Expr | null;
  ctorArgs: Expr[] | null;
  line: number;
}

export type Stmt =
  | { k: "block"; body: Stmt[]; line: number }
  | { k: "if"; c: Expr; t: Stmt; f: Stmt | null; line: number }
  | { k: "for"; init: Stmt | null; cond: Expr | null; step: Expr | null; body: Stmt; line: number }
  | { k: "while"; c: Expr; body: Stmt; line: number }
  | { k: "do"; c: Expr; body: Stmt; line: number }
  | { k: "switch"; e: Expr; cases: { match: Expr | null; body: Stmt[] }[]; line: number }
  | { k: "break"; line: number }
  | { k: "continue"; line: number }
  | { k: "return"; e: Expr | null; line: number }
  | { k: "decl"; ts: TypeSpec; vars: Declarator[]; line: number }
  | { k: "expr"; e: Expr; line: number }
  | { k: "empty"; line: number };

export interface Param {
  ts: TypeSpec;
  name: string;
  isArray: boolean;
}

export type TopLevel =
  | { k: "func"; ret: TypeSpec; name: string; params: Param[]; body: Stmt[] | null; line: number }
  | { k: "decl"; ts: TypeSpec; vars: Declarator[]; line: number }
  | { k: "enum"; items: { name: string; value: Expr | null }[]; line: number };

export interface Program {
  items: TopLevel[];
}

// ───────────────────────── parser ─────────────────────────

const TYPE_WORDS = new Set([
  "void", "bool", "boolean", "char", "byte", "word", "int", "short", "long", "unsigned", "signed", "float", "double",
  "size_t", "uint8_t", "uint16_t", "uint32_t", "uint64_t", "int8_t", "int16_t", "int32_t", "int64_t",
  "String", "Servo", "LiquidCrystal",
]);
const QUALIFIERS = new Set(["const", "static", "volatile", "extern", "inline", "register", "constexpr", "PROGMEM", "IRAM_ATTR"]);

const BIN_PREC: Record<string, number> = {
  "||": 1, "&&": 2, "|": 3, "^": 4, "&": 5, "==": 6, "!=": 6, "<": 7, ">": 7, "<=": 7, ">=": 7, "<<": 8, ">>": 8, "+": 9, "-": 9, "*": 10, "/": 10, "%": 10,
};
const ASSIGN_OPS = new Set(["=", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=", "<<=", ">>="]);

export function parseProgram(tokens: Token[], intBits: 16 | 32): Program {
  let p = 0;
  const aliases = new Map<string, TypeSpec>();

  const peek = (o = 0): Token => tokens[Math.min(p + o, tokens.length - 1)]!;
  const next = (): Token => tokens[Math.min(p++, tokens.length - 1)]!;
  const isOp = (v: string, o = 0): boolean => peek(o).t === "op" && peek(o).v === v;
  const isId = (v: string, o = 0): boolean => peek(o).t === "id" && peek(o).v === v;
  const fail = (msg: string, t: Token = peek()): never => {
    throw new CompileError(msg, t.line, t.col);
  };
  const expectOp = (v: string): Token => {
    if (!isOp(v)) fail(`Expected "${v}" but found "${peek().t === "eof" ? "end of file" : peek().v}".`);
    return next();
  };
  const expectId = (): Token => {
    if (peek().t !== "id") fail(`Expected a name but found "${peek().v || "end of file"}".`);
    return next();
  };

  const isTypeWord = (t: Token): boolean => t.t === "id" && (TYPE_WORDS.has(t.v) || aliases.has(t.v) || QUALIFIERS.has(t.v));

  /** Parse a type specifier if one starts here. */
  function parseTypeSpec(): TypeSpec | null {
    if (!isTypeWord(peek())) return null;
    let isConst = false;
    let isStatic = false;
    let unsigned = false;
    let signedKw = false;
    let longs = 0;
    let short = false;
    let base: string | null = null;
    let alias: TypeSpec | null = null;
    let any = false;
    for (;;) {
      const t = peek();
      if (t.t !== "id") break;
      if (QUALIFIERS.has(t.v)) {
        if (t.v === "const" || t.v === "constexpr") isConst = true;
        if (t.v === "static") isStatic = true;
        next();
        any = true;
        continue;
      }
      if (aliases.has(t.v) && base === null && !unsigned && !signedKw && longs === 0 && !short) {
        alias = aliases.get(t.v)!;
        next();
        any = true;
        continue;
      }
      if (!TYPE_WORDS.has(t.v)) break;
      if (t.v === "unsigned") unsigned = true;
      else if (t.v === "signed") signedKw = true;
      else if (t.v === "long") longs++;
      else if (t.v === "short") short = true;
      else if (base === null || (base === "int" && false)) base = t.v;
      else if (t.v === "int" && (longs > 0 || short)) {
        /* "long int", "short int" */
      } else break;
      next();
      any = true;
    }
    if (!any) return null;
    let ts: TypeSpec;
    if (alias) ts = { ...alias, isConst: alias.isConst || isConst };
    else ts = resolveBase(base, unsigned, signedKw, longs, short, isConst);
    while (isOp("*")) {
      next();
      ts = { ...ts, ptr: ts.ptr + 1 };
    }
    if (isStatic) ts = { ...ts, isStatic: true };
    return ts;
  }

  function resolveBase(base: string | null, unsigned: boolean, signedKw: boolean, longs: number, short: boolean, isConst: boolean): TypeSpec {
    const mkInt = (bits: number, signed: boolean): TypeSpec => ({ base: "int", bits, signed, ptr: 0, isConst });
    if (base === null || base === "int") {
      if (short) return mkInt(16, !unsigned);
      if (longs >= 2) return mkInt(64, !unsigned);
      if (longs === 1) return mkInt(32, !unsigned);
      void signedKw;
      return mkInt(intBits, !unsigned);
    }
    switch (base) {
      case "void":
        return { base: "void", bits: 0, signed: true, ptr: 0, isConst };
      case "bool":
      case "boolean":
        return { base: "bool", bits: 8, signed: false, ptr: 0, isConst };
      case "char":
        return { base: "char", bits: 8, signed: !unsigned, ptr: 0, isConst };
      case "byte":
      case "uint8_t":
        return mkInt(8, false);
      case "int8_t":
        return mkInt(8, true);
      case "word":
      case "uint16_t":
        return mkInt(16, false);
      case "int16_t":
        return mkInt(16, true);
      case "uint32_t":
        return mkInt(32, false);
      case "int32_t":
        return mkInt(32, true);
      case "uint64_t":
        return mkInt(64, false);
      case "int64_t":
        return mkInt(64, true);
      case "size_t":
        return mkInt(intBits, false);
      case "float":
      case "double":
        return { base: "float", bits: 32, signed: true, ptr: 0, isConst };
      case "long":
        return mkInt(32, !unsigned);
      case "unsigned":
        return mkInt(intBits, false);
      case "String":
        return { base: "String", bits: 0, signed: true, ptr: 0, isConst };
      case "Servo":
        return { base: "Servo", bits: 0, signed: true, ptr: 0, isConst };
      case "LiquidCrystal":
        return { base: "LiquidCrystal", bits: 0, signed: true, ptr: 0, isConst };
      default:
        return fail(`Unknown type "${base}".`);
    }
  }

  // ───────── expressions

  function parseExpr(): Expr {
    return parseAssign();
  }

  function parseAssign(): Expr {
    const lhs = parseTernary();
    const t = peek();
    if (t.t === "op" && ASSIGN_OPS.has(t.v)) {
      next();
      const rhs = parseAssign();
      return { k: "assign", op: t.v, l: lhs, r: rhs, line: t.line };
    }
    return lhs;
  }

  function parseTernary(): Expr {
    const c = parseBinary(1);
    if (isOp("?")) {
      const t = next();
      const a = parseAssign();
      expectOp(":");
      const b = parseAssign();
      return { k: "cond", c, a, b, line: t.line };
    }
    return c;
  }

  function parseBinary(minPrec: number): Expr {
    let lhs = parseUnary();
    for (;;) {
      const t = peek();
      const prec = t.t === "op" ? BIN_PREC[t.v] : undefined;
      if (prec === undefined || prec < minPrec) break;
      next();
      const rhs = parseBinary(prec + 1);
      lhs = { k: "bin", op: t.v, l: lhs, r: rhs, line: t.line };
    }
    return lhs;
  }

  function startsCast(): boolean {
    if (!isOp("(")) return false;
    const t = peek(1);
    if (!isTypeWord(t)) return false;
    // (type) … — scan to the closing paren; every token must be a type word or '*'
    let o = 1;
    while (peek(o).t === "id" && isTypeWord(peek(o))) o++;
    while (isOp("*", o)) o++;
    return isOp(")", o);
  }

  function parseUnary(): Expr {
    const t = peek();
    if (t.t === "op") {
      if (t.v === "-" || t.v === "+" || t.v === "!" || t.v === "~") {
        next();
        return { k: "un", op: t.v, e: parseUnary(), line: t.line };
      }
      if (t.v === "++" || t.v === "--") {
        next();
        return { k: "pre", op: t.v, e: parseUnary(), line: t.line };
      }
      if (t.v === "&" || t.v === "*") fail("Pointers and address-of are not supported in this simulator.", t);
      if (startsCast()) {
        next();
        const ts = parseTypeSpec()!;
        expectOp(")");
        return { k: "cast", type: ts, e: parseUnary(), line: t.line };
      }
    }
    if (t.t === "id" && t.v === "sizeof") {
      next();
      if (isOp("(")) {
        if (isTypeWord(peek(1))) {
          next();
          const ts = parseTypeSpec()!;
          expectOp(")");
          return { k: "sizeof", type: ts, e: null, line: t.line };
        }
        next();
        const e = parseExpr();
        expectOp(")");
        return { k: "sizeof", type: null, e, line: t.line };
      }
      return { k: "sizeof", type: null, e: parseUnary(), line: t.line };
    }
    return parsePostfix();
  }

  function parseArgs(): Expr[] {
    const args: Expr[] = [];
    expectOp("(");
    if (!isOp(")")) {
      for (;;) {
        args.push(parseAssign());
        if (isOp(",")) {
          next();
          continue;
        }
        break;
      }
    }
    expectOp(")");
    return args;
  }

  function parsePostfix(): Expr {
    let e = parsePrimary();
    for (;;) {
      const t = peek();
      if (t.t !== "op") break;
      if (t.v === "[") {
        next();
        const i = parseExpr();
        expectOp("]");
        e = { k: "idx", e, i, line: t.line };
      } else if (t.v === "(") {
        if (e.k !== "id") fail("Only named functions can be called.", t);
        e = { k: "call", name: (e as { name: string }).name, args: parseArgs(), line: t.line };
      } else if (t.v === ".") {
        next();
        const name = expectId().v;
        if (!isOp("(")) fail(`Member "${name}" is not supported; only method calls are.`, t);
        e = { k: "mcall", obj: e, name, args: parseArgs(), line: t.line };
      } else if (t.v === "->") {
        fail("Pointers are not supported in this simulator.", t);
      } else if (t.v === "++" || t.v === "--") {
        next();
        e = { k: "post", op: t.v, e, line: t.line };
      } else break;
    }
    return e;
  }

  function parsePrimary(): Expr {
    const t = next();
    switch (t.t) {
      case "num":
        return { k: "num", v: t.n, isFloat: t.isFloat, suffix: t.suffix, hex: t.hex, line: t.line };
      case "str": {
        let s = t.v;
        while (peek().t === "str") s += next().v; // adjacent literal concatenation
        return { k: "str", v: s, line: t.line };
      }
      case "chr":
        return { k: "chr", v: t.n, line: t.line };
      case "id": {
        // functional cast: int(x), float(x), String(x) …
        if ((TYPE_WORDS.has(t.v) || aliases.has(t.v)) && isOp("(")) {
          p--;
          const ts = parseTypeSpec()!;
          expectOp("(");
          const arg = isOp(")") ? ({ k: "str", v: "", line: t.line } as Expr) : parseExpr();
          expectOp(")");
          return { k: "cast", type: ts, e: arg, line: t.line };
        }
        return { k: "id", name: t.v, line: t.line };
      }
      case "op":
        if (t.v === "(") {
          const e = parseExpr();
          expectOp(")");
          return e;
        }
        if (t.v === "{") {
          const items: Expr[] = [];
          if (!isOp("}")) {
            for (;;) {
              items.push(parseInitItem());
              if (isOp(",")) {
                next();
                if (isOp("}")) break;
                continue;
              }
              break;
            }
          }
          expectOp("}");
          return { k: "list", items, line: t.line };
        }
        return fail(`Unexpected "${t.v}".`, t);
      default:
        return fail("Unexpected end of file.", t);
    }
  }

  function parseInitItem(): Expr {
    return isOp("{") ? parsePrimary() : parseAssign();
  }

  // ───────── statements

  function parseDeclarators(ts: TypeSpec, isTop: boolean): Declarator[] {
    const vars: Declarator[] = [];
    for (;;) {
      const nameTok = expectId();
      const dims: (Expr | null)[] = [];
      while (isOp("[")) {
        next();
        if (isOp("]")) dims.push(null);
        else dims.push(parseTernary());
        expectOp("]");
      }
      let init: Expr | null = null;
      let ctorArgs: Expr[] | null = null;
      if (isOp("=")) {
        next();
        init = isOp("{") ? parsePrimary() : parseAssign();
      } else if (isOp("(") && (ts.base === "LiquidCrystal" || ts.base === "Servo" || ts.base === "String")) {
        ctorArgs = parseArgs();
      }
      void isTop;
      vars.push({ name: nameTok.v, dims, init, ctorArgs, line: nameTok.line });
      if (isOp(",")) {
        next();
        continue;
      }
      break;
    }
    return vars;
  }

  function isDeclStart(): boolean {
    const t = peek();
    if (!isTypeWord(t)) return false;
    // "String(x)" / "int(x)" as an expression statement
    if (!QUALIFIERS.has(t.v) && isOp("(", 1)) return false;
    return true;
  }

  function parseBlockBody(): Stmt[] {
    const body: Stmt[] = [];
    while (!isOp("}")) {
      if (peek().t === "eof") fail('Missing closing "}".');
      body.push(parseStmt());
    }
    expectOp("}");
    return body;
  }

  function parseStmt(): Stmt {
    const t = peek();
    const line = t.line;
    if (t.t === "op") {
      if (t.v === "{") {
        next();
        return { k: "block", body: parseBlockBody(), line };
      }
      if (t.v === ";") {
        next();
        return { k: "empty", line };
      }
    }
    if (t.t === "id") {
      switch (t.v) {
        case "if": {
          next();
          expectOp("(");
          const c = parseExpr();
          expectOp(")");
          const th = parseStmt();
          let el: Stmt | null = null;
          if (isId("else")) {
            next();
            el = parseStmt();
          }
          return { k: "if", c, t: th, f: el, line };
        }
        case "while": {
          next();
          expectOp("(");
          const c = parseExpr();
          expectOp(")");
          return { k: "while", c, body: parseStmt(), line };
        }
        case "do": {
          next();
          const body = parseStmt();
          if (!isId("while")) fail('Expected "while" after do-block.');
          next();
          expectOp("(");
          const c = parseExpr();
          expectOp(")");
          expectOp(";");
          return { k: "do", c, body, line };
        }
        case "for": {
          next();
          expectOp("(");
          let init: Stmt | null = null;
          if (!isOp(";")) {
            if (isDeclStart()) {
              const ts = parseTypeSpec()!;
              init = { k: "decl", ts, vars: parseDeclarators(ts, false), line };
            } else init = { k: "expr", e: parseExpr(), line };
          }
          expectOp(";");
          const cond = isOp(";") ? null : parseExpr();
          expectOp(";");
          const step = isOp(")") ? null : parseExprList();
          expectOp(")");
          return { k: "for", init, cond, step, body: parseStmt(), line };
        }
        case "switch": {
          next();
          expectOp("(");
          const e = parseExpr();
          expectOp(")");
          expectOp("{");
          const cases: { match: Expr | null; body: Stmt[] }[] = [];
          while (!isOp("}")) {
            let match: Expr | null = null;
            if (isId("case")) {
              next();
              match = parseTernary();
            } else if (isId("default")) {
              next();
            } else fail('Expected "case" or "default".');
            expectOp(":");
            const body: Stmt[] = [];
            while (!isOp("}") && !isId("case") && !isId("default")) {
              if (peek().t === "eof") fail('Missing closing "}".');
              body.push(parseStmt());
            }
            cases.push({ match, body });
          }
          expectOp("}");
          return { k: "switch", e, cases, line };
        }
        case "break":
          next();
          expectOp(";");
          return { k: "break", line };
        case "continue":
          next();
          expectOp(";");
          return { k: "continue", line };
        case "return": {
          next();
          const e = isOp(";") ? null : parseExpr();
          expectOp(";");
          return { k: "return", e, line };
        }
        case "goto":
          return fail("goto is not supported.");
        case "struct":
        case "class":
        case "union":
          return fail(`"${t.v}" is not supported in this simulator.`);
        default:
          break;
      }
    }
    if (isDeclStart()) {
      const ts = parseTypeSpec()!;
      const vars = parseDeclarators(ts, false);
      expectOp(";");
      return { k: "decl", ts, vars, line };
    }
    const e = parseExprList();
    expectOp(";");
    return { k: "expr", e, line };
  }

  /** Comma-separated expression list (for-loop steps); folded into a nested comma `bin`. */
  function parseExprList(): Expr {
    let e = parseExpr();
    while (isOp(",")) {
      const t = next();
      const r = parseExpr();
      e = { k: "bin", op: ",", l: e, r, line: t.line };
    }
    return e;
  }

  // ───────── top level

  const items: TopLevel[] = [];
  while (peek().t !== "eof") {
    const t = peek();
    if (isOp(";")) {
      next();
      continue;
    }
    if (isId("typedef")) {
      next();
      const ts = parseTypeSpec();
      if (!ts) fail("Unsupported typedef.");
      const name = expectId().v;
      expectOp(";");
      aliases.set(name, ts!);
      continue;
    }
    if (isId("enum")) {
      next();
      let enumName: string | null = null;
      if (peek().t === "id") enumName = next().v;
      expectOp("{");
      const list: { name: string; value: Expr | null }[] = [];
      while (!isOp("}")) {
        const name = expectId().v;
        let value: Expr | null = null;
        if (isOp("=")) {
          next();
          value = parseTernary();
        }
        list.push({ name, value });
        if (isOp(",")) next();
        else break;
      }
      expectOp("}");
      expectOp(";");
      if (enumName) aliases.set(enumName, { base: "int", bits: intBits, signed: true, ptr: 0, isConst: false });
      items.push({ k: "enum", items: list, line: t.line });
      continue;
    }
    if (isId("struct") || isId("class") || isId("union") || isId("namespace") || isId("template")) {
      fail(`"${t.v}" is not supported in this simulator.`);
    }
    const ts = parseTypeSpec();
    if (!ts) fail(`Unexpected "${t.v}" at top level.`);
    const spec = ts!;
    // function?
    if (peek().t === "id" && isOp("(", 1) && spec.base !== "LiquidCrystal" && spec.base !== "Servo") {
      const nameTok = next();
      next(); // (
      const params: Param[] = [];
      if (isId("void") && isOp(")", 1)) next();
      else if (!isOp(")")) {
        for (;;) {
          const pts = parseTypeSpec();
          if (!pts) fail("Expected a parameter type.");
          if (isOp("&")) fail("Reference parameters are not supported in this simulator.");
          let name = "";
          if (peek().t === "id") name = next().v;
          let isArray = false;
          while (isOp("[")) {
            next();
            if (!isOp("]")) parseTernary();
            expectOp("]");
            isArray = true;
          }
          params.push({ ts: pts!, name, isArray });
          if (isOp(",")) {
            next();
            continue;
          }
          break;
        }
      }
      expectOp(")");
      if (isOp(";")) {
        next();
        items.push({ k: "func", ret: spec, name: nameTok.v, params, body: null, line: nameTok.line });
        continue;
      }
      expectOp("{");
      items.push({ k: "func", ret: spec, name: nameTok.v, params, body: parseBlockBody(), line: nameTok.line });
      continue;
    }
    const vars = parseDeclarators(spec, true);
    expectOp(";");
    items.push({ k: "decl", ts: spec, vars, line: t.line });
  }
  return { items };
}
