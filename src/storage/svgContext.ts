/**
 * Minimal CanvasRenderingContext2D look-alike that records drawing calls as SVG.
 * Only the subset used by the scene renderer is implemented; curves are flattened to
 * polylines so that mirrored / rotated parts need no special handling.
 */

type Mat = [number, number, number, number, number, number];

interface State {
  m: Mat;
  fillStyle: unknown;
  strokeStyle: unknown;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: string;
  dash: number[];
  lineCap: string;
  lineJoin: string;
}

const mul = (a: Mat, b: Mat): Mat => [
  a[0] * b[0] + a[2] * b[1],
  a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3],
  a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4],
  a[1] * b[4] + a[3] * b[5] + a[5],
];

const f = (n: number): string => (Math.round(n * 100) / 100).toString();

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

class FakeGradient {
  addColorStop(): void {
    /* gradients are not exported */
  }
}

export class SvgContext {
  private out: string[] = [];
  private stack: State[] = [];
  private s: State = {
    m: [1, 0, 0, 1, 0, 0],
    fillStyle: "#000",
    strokeStyle: "#000",
    lineWidth: 1,
    globalAlpha: 1,
    font: "10px monospace",
    textAlign: "start",
    dash: [],
    lineCap: "butt",
    lineJoin: "miter",
  };
  private path: string[] = [];
  private cur: [number, number] = [0, 0];
  private start: [number, number] = [0, 0];

  // write-only properties the renderer sets and we ignore
  textBaseline = "alphabetic";
  globalCompositeOperation = "source-over";
  lineDashOffset = 0;
  shadowColor = "";
  shadowBlur = 0;

  constructor(
    readonly width: number,
    readonly height: number,
    background: string | null,
  ) {
    if (background) this.out.push(`<rect width="${width}" height="${height}" fill="${background}"/>`);
  }

  get fillStyle(): unknown {
    return this.s.fillStyle;
  }
  set fillStyle(v: unknown) {
    this.s.fillStyle = v;
  }
  get strokeStyle(): unknown {
    return this.s.strokeStyle;
  }
  set strokeStyle(v: unknown) {
    this.s.strokeStyle = v;
  }
  get lineWidth(): number {
    return this.s.lineWidth;
  }
  set lineWidth(v: number) {
    this.s.lineWidth = v;
  }
  get globalAlpha(): number {
    return this.s.globalAlpha;
  }
  set globalAlpha(v: number) {
    this.s.globalAlpha = v;
  }
  get font(): string {
    return this.s.font;
  }
  set font(v: string) {
    this.s.font = v;
  }
  get textAlign(): string {
    return this.s.textAlign;
  }
  set textAlign(v: string) {
    this.s.textAlign = v;
  }
  get lineCap(): string {
    return this.s.lineCap;
  }
  set lineCap(v: string) {
    this.s.lineCap = v;
  }
  get lineJoin(): string {
    return this.s.lineJoin;
  }
  set lineJoin(v: string) {
    this.s.lineJoin = v;
  }

  // ───── state
  save(): void {
    this.stack.push({ ...this.s, m: [...this.s.m] as Mat, dash: [...this.s.dash] });
  }
  restore(): void {
    const p = this.stack.pop();
    if (p) this.s = p;
  }
  translate(x: number, y: number): void {
    this.s.m = mul(this.s.m, [1, 0, 0, 1, x, y]);
  }
  scale(x: number, y: number): void {
    this.s.m = mul(this.s.m, [x, 0, 0, y, 0, 0]);
  }
  rotate(a: number): void {
    const c = Math.cos(a);
    const s = Math.sin(a);
    this.s.m = mul(this.s.m, [c, s, -s, c, 0, 0]);
  }
  setTransform(a: number, b: number, c: number, d: number, e: number, ff: number): void {
    this.s.m = [a, b, c, d, e, ff];
  }
  setLineDash(d: number[]): void {
    this.s.dash = d;
  }

  // ───── paths
  private pt(x: number, y: number): [number, number] {
    const m = this.s.m;
    return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
  }
  beginPath(): void {
    this.path = [];
  }
  closePath(): void {
    this.path.push("Z");
    this.cur = this.start;
  }
  moveTo(x: number, y: number): void {
    const p = this.pt(x, y);
    this.path.push(`M${f(p[0])} ${f(p[1])}`);
    this.cur = p;
    this.start = p;
  }
  lineTo(x: number, y: number): void {
    const p = this.pt(x, y);
    this.path.push(this.path.length === 0 ? `M${f(p[0])} ${f(p[1])}` : `L${f(p[0])} ${f(p[1])}`);
    this.cur = p;
  }
  arc(x: number, y: number, r: number, a0: number, a1: number, ccw = false): void {
    this.ellipse(x, y, r, r, 0, a0, a1, ccw);
  }
  ellipse(x: number, y: number, rx: number, ry: number, rot: number, a0: number, a1: number, ccw = false): void {
    let d = a1 - a0;
    if (!ccw && d < 0) d += Math.PI * 2 * Math.ceil(-d / (Math.PI * 2));
    if (ccw && d > 0) d -= Math.PI * 2 * Math.ceil(d / (Math.PI * 2));
    if (Math.abs(d) > Math.PI * 2) d = Math.sign(d) * Math.PI * 2;
    const n = Math.max(4, Math.ceil((Math.abs(d) / (Math.PI * 2)) * 36));
    const cr = Math.cos(rot);
    const sr = Math.sin(rot);
    for (let i = 0; i <= n; i++) {
      const a = a0 + (d * i) / n;
      const px = rx * Math.cos(a);
      const py = ry * Math.sin(a);
      const lx = x + px * cr - py * sr;
      const ly = y + px * sr + py * cr;
      if (i === 0 && this.path.length === 0) this.moveTo(lx, ly);
      else this.lineTo(lx, ly);
    }
  }
  quadraticCurveTo(cx: number, cy: number, x: number, y: number): void {
    // endpoints are device-space already; invert to local for the polyline helper
    const inv = this.invPt(this.cur[0], this.cur[1]);
    for (let i = 1; i <= 12; i++) {
      const t = i / 12;
      const u = 1 - t;
      this.lineTo(u * u * inv[0] + 2 * u * t * cx + t * t * x, u * u * inv[1] + 2 * u * t * cy + t * t * y);
    }
  }
  private invPt(dx: number, dy: number): [number, number] {
    const [a, b, c, d, e, ff] = this.s.m;
    const det = a * d - b * c || 1;
    const x = dx - e;
    const y = dy - ff;
    return [(d * x - c * y) / det, (-b * x + a * y) / det];
  }
  rect(x: number, y: number, w: number, h: number): void {
    this.moveTo(x, y);
    this.lineTo(x + w, y);
    this.lineTo(x + w, y + h);
    this.lineTo(x, y + h);
    this.closePath();
  }
  roundRect(x: number, y: number, w: number, h: number, _r?: number): void {
    this.rect(x, y, w, h);
  }

  // ───── painting
  private color(v: unknown): string | null {
    return typeof v === "string" ? v : null;
  }
  private scaleFactor(): number {
    const [a, b, c, d] = this.s.m;
    return Math.sqrt(Math.abs(a * d - b * c));
  }
  private paint(d: string, fill: string | null, stroke: string | null): void {
    if (!d) return;
    const op = this.s.globalAlpha < 1 ? ` opacity="${f(this.s.globalAlpha)}"` : "";
    const dash = this.s.dash.length ? ` stroke-dasharray="${this.s.dash.map((n) => f(n * this.scaleFactor())).join(" ")}"` : "";
    this.out.push(
      `<path d="${d}" fill="${fill ?? "none"}"${
        stroke ? ` stroke="${stroke}" stroke-width="${f(this.s.lineWidth * this.scaleFactor())}" stroke-linecap="${this.s.lineCap === "round" ? "round" : "butt"}" stroke-linejoin="${this.s.lineJoin === "round" ? "round" : "miter"}"${dash}` : ""
      }${op}/>`,
    );
  }
  fill(): void {
    this.paint(this.path.join(""), this.color(this.s.fillStyle), null);
  }
  stroke(): void {
    this.paint(this.path.join(""), null, this.color(this.s.strokeStyle));
  }
  fillRect(x: number, y: number, w: number, h: number): void {
    const keep = this.path;
    this.beginPath();
    this.rect(x, y, w, h);
    this.fill();
    this.path = keep;
  }
  strokeRect(x: number, y: number, w: number, h: number): void {
    const keep = this.path;
    this.beginPath();
    this.rect(x, y, w, h);
    this.stroke();
    this.path = keep;
  }
  fillText(t: string, x: number, y: number): void {
    const col = this.color(this.s.fillStyle);
    if (!col) return;
    const m = this.s.m;
    const px = /(\d+(?:\.\d+)?)px/.exec(this.s.font);
    const size = px ? Number(px[1]) : 10;
    const weight = /\b(600|700|bold)\b/.test(this.s.font) ? ' font-weight="700"' : "";
    const anchor = this.s.textAlign === "center" ? "middle" : this.s.textAlign === "right" || this.s.textAlign === "end" ? "end" : "start";
    const op = this.s.globalAlpha < 1 ? ` opacity="${f(this.s.globalAlpha)}"` : "";
    this.out.push(
      `<text transform="matrix(${m.map(f).join(" ")})" x="${f(x)}" y="${f(y)}" font-family="Menlo, Consolas, monospace" font-size="${f(size)}"${weight} text-anchor="${anchor}" dominant-baseline="central" fill="${col}"${op}>${esc(t)}</text>`,
    );
  }
  measureText(t: string): { width: number } {
    const px = /(\d+(?:\.\d+)?)px/.exec(this.s.font);
    return { width: t.length * (px ? Number(px[1]) : 10) * 0.6 };
  }
  createLinearGradient(): FakeGradient {
    return new FakeGradient();
  }
  createRadialGradient(): FakeGradient {
    return new FakeGradient();
  }

  toSvg(title: string): string {
    return `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${this.width}" height="${this.height}" viewBox="0 0 ${this.width} ${this.height}">\n<title>${esc(title)}</title>\n${this.out.join("\n")}\n</svg>\n`;
  }
}
