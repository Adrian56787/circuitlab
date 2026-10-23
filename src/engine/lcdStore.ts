/** Display contents of HD44780 LCDs, written by the LCD device model and read by the renderer. */

export interface LcdState {
  /** 80-byte DDRAM (two 40-char lines) */
  ddram: Uint8Array;
  /** CGRAM user characters, 8 × 8 rows */
  cgram: Uint8Array;
  on: boolean;
  cursorOn: boolean;
  blinkOn: boolean;
  cursor: number;
  /** shown once the controller has been initialised by a sketch */
  initialised: boolean;
  shift: number;
}

const store = new Map<string, LcdState>();

export function lcdState(id: string): LcdState {
  let s = store.get(id);
  if (!s) {
    s = {
      ddram: new Uint8Array(80).fill(32),
      cgram: new Uint8Array(64),
      on: false,
      cursorOn: false,
      blinkOn: false,
      cursor: 0,
      initialised: false,
      shift: 0,
    };
    store.set(id, s);
  }
  return s;
}
export function peekLcd(id: string): LcdState | undefined {
  return store.get(id);
}
export function resetLcd(id: string): void {
  store.delete(id);
}
