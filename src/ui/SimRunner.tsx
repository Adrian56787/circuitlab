"use client";

import { useEffect } from "react";
import { burnTimes, setLive, sim } from "@/engine/runtime";
import { CATALOG } from "@/models/catalog";
import { useCircuitStore } from "@/store/circuitStore";
import { useSimStore } from "@/store/simulationStore";

/** Pick a solver step that resolves the fastest source in the circuit (≥ 40 steps per cycle). */
function autoDt(base: number): number {
  const { components } = useCircuitStore.getState();
  let fmax = 0;
  for (const c of components) {
    if (c.kind === "vac" || c.kind === "sigen") {
      const f = Number(c.params.frequency);
      if (Number.isFinite(f)) fmax = Math.max(fmax, f);
    }
  }
  return fmax > 0 ? Math.min(base, 1 / (fmax * 80)) : base;
}

/**
 * Headless component: owns the animation-frame loop that recompiles the netlist when the
 * circuit changes, advances the solver, and publishes snapshots.
 */
export function SimRunner(): null {
  useEffect(() => {
    let raf = 0;
    let last = performance.now();
    let lastRevision = -1;
    let lastBump = 0;
    let handledStep = 0;
    let handledReset = 0;

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      const frameSec = Math.min(0.1, (now - last) / 1000);
      last = now;

      const circuit = useCircuitStore.getState();
      const ctl = useSimStore.getState();

      if (circuit.revision !== lastRevision) {
        lastRevision = circuit.revision;
        sim.compile(circuit.components, circuit.wires);
        if (sim.time > 0 || ctl.running) setLive(sim.snapshot());
      }

      if (ctl.resetRequests !== handledReset) {
        handledReset = ctl.resetRequests;
        sim.reset();
        burnTimes.clear();
        setLive(null);
        ctl.bump();
      }

      const dtBase = autoDt(ctl.baseDt);
      let changed = false;

      if (ctl.stepRequests !== handledStep) {
        handledStep = ctl.stepRequests;
        for (let i = 0; i < 1; i++) sim.step(dtBase);
        changed = true;
      } else if (ctl.running && CATALOG && circuit.components.length > 0) {
        sim.advance(frameSec * ctl.speed, dtBase, 400, 10);
        changed = true;
      }

      if (changed) {
        setLive(sim.snapshot());
        if (now - lastBump > 100) {
          lastBump = now;
          ctl.bump();
        }
      }
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return null;
}
