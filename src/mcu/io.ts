/** Per-microcontroller I/O buffers shared between the simulator (writer) and the UI (reader). */

const MAX_LOG = 40_000;

export class McuIo {
  /** Text printed with Serial */
  log = "";
  /** Bytes waiting to be read by the sketch (typed in the serial monitor) */
  rx: number[] = [];
  /** Compile/runtime status shown in the code panel */
  status: { kind: "idle" | "running" | "error" | "off"; message: string } = { kind: "idle", message: "" };
  baud = 9600;
  private readonly listeners = new Set<() => void>();
  version = 0;

  write(text: string): void {
    this.log += text.replace(/\r/g, "");
    if (this.log.length > MAX_LOG) this.log = this.log.slice(this.log.length - MAX_LOG);
    this.notify();
  }
  clear(): void {
    this.log = "";
    this.notify();
  }
  sendLine(text: string, newline = true): void {
    for (const ch of text + (newline ? "\n" : "")) this.rx.push(ch.charCodeAt(0) & 255);
    this.notify();
  }
  setStatus(kind: McuIo["status"]["kind"], message = ""): void {
    if (this.status.kind === kind && this.status.message === message) return;
    this.status = { kind, message };
    this.notify();
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  private notify(): void {
    this.version++;
    for (const l of this.listeners) l();
  }
}

const registry = new Map<string, McuIo>();
export function getIo(id: string): McuIo {
  let io = registry.get(id);
  if (!io) {
    io = new McuIo();
    registry.set(id, io);
  }
  return io;
}
export function dropIo(id: string): void {
  registry.delete(id);
}
export function allIoIds(): string[] {
  return [...registry.keys()];
}
