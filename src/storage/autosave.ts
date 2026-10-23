import { useCircuitStore } from "@/store/circuitStore";
import { CircuitFormatError, parseCircuit, serializeCircuit } from "./serialize";

const KEY = "circuitlab:autosave:v1";

/** Restore the last session's circuit, if any. Returns true when something was loaded. */
export function restoreAutosave(): boolean {
  try {
    const text = window.localStorage.getItem(KEY);
    if (!text) return false;
    const data = parseCircuit(text);
    if (data.components.length === 0) return false;
    useCircuitStore.getState().load(data);
    return true;
  } catch (e) {
    if (!(e instanceof CircuitFormatError)) console.warn("autosave restore failed", e);
    return false;
  }
}

/** Persist the circuit (debounced) whenever it changes. Returns an unsubscribe function. */
export function startAutosave(): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let lastRevision = useCircuitStore.getState().revision;
  const unsub = useCircuitStore.subscribe((s) => {
    if (s.revision === lastRevision) return;
    lastRevision = s.revision;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      try {
        window.localStorage.setItem(KEY, serializeCircuit(useCircuitStore.getState().toData()));
      } catch {
        /* storage full or blocked — autosave is best-effort */
      }
    }, 600);
  });
  return () => {
    unsub();
    if (timer) clearTimeout(timer);
  };
}
