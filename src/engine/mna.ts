/**
 * Dense Modified Nodal Analysis workspace.
 *
 * Unknown vector layout: [ node voltages (0 … nodeCount-1) | voltage-source branch currents ].
 * Node index −1 is the ground reference and is never stamped.
 *
 * Sign convention: each node row states "sum of currents LEAVING the node = 0".
 */
export class Stamper {
  readonly size: number;
  readonly A: Float64Array;
  readonly b: Float64Array;

  constructor(
    readonly nodeCount: number,
    readonly branchCount: number,
  ) {
    this.size = nodeCount + branchCount;
    this.A = new Float64Array(this.size * this.size);
    this.b = new Float64Array(this.size);
  }

  clear(): void {
    this.A.fill(0);
    this.b.fill(0);
  }

  copyFrom(o: Stamper): void {
    this.A.set(o.A);
    this.b.set(o.b);
  }

  add(r: number, c: number, v: number): void {
    if (r < 0 || c < 0) return;
    this.A[r * this.size + c]! += v;
  }

  rhs(r: number, v: number): void {
    if (r < 0) return;
    this.b[r]! += v;
  }

  /** Conductance G between nodes a and b. */
  conductance(a: number, b: number, g: number): void {
    this.add(a, a, g);
    this.add(b, b, g);
    this.add(a, b, -g);
    this.add(b, a, -g);
  }

  /** Element obeying  i(a→b) = g·(va − vb) + j. */
  branch(a: number, b: number, g: number, j: number): void {
    if (g !== 0) this.conductance(a, b, g);
    if (j !== 0) {
      this.rhs(a, -j);
      this.rhs(b, j);
    }
  }

  /** Ideal voltage source, branch current flows p → n through the source. */
  voltageSource(branchIndex: number, p: number, n: number, volts: number): void {
    const row = this.nodeCount + branchIndex;
    this.add(p, row, 1);
    this.add(n, row, -1);
    this.add(row, p, 1);
    this.add(row, n, -1);
    this.b[row]! += volts;
  }
}

/**
 * Solve A·x = b in place (Gaussian elimination with partial pivoting).
 * `A` and `b` are destroyed. Returns false if the matrix is singular.
 */
export function solveInPlace(A: Float64Array, b: Float64Array, n: number, x: Float64Array): boolean {
  for (let col = 0; col < n; col++) {
    let piv = col;
    let best = Math.abs(A[col * n + col]!);
    for (let r = col + 1; r < n; r++) {
      const v = Math.abs(A[r * n + col]!);
      if (v > best) {
        best = v;
        piv = r;
      }
    }
    if (best < 1e-18) return false;
    if (piv !== col) {
      for (let c = col; c < n; c++) {
        const t = A[col * n + c]!;
        A[col * n + c] = A[piv * n + c]!;
        A[piv * n + c] = t;
      }
      const tb = b[col]!;
      b[col] = b[piv]!;
      b[piv] = tb;
    }
    const d = A[col * n + col]!;
    for (let r = col + 1; r < n; r++) {
      const f = A[r * n + col]! / d;
      if (f === 0) continue;
      A[r * n + col] = 0;
      for (let c = col + 1; c < n; c++) A[r * n + c]! -= f * A[col * n + c]!;
      b[r]! -= f * b[col]!;
    }
  }
  for (let r = n - 1; r >= 0; r--) {
    let s = b[r]!;
    for (let c = r + 1; c < n; c++) s -= A[r * n + c]! * x[c]!;
    x[r] = s / A[r * n + r]!;
  }
  return true;
}
