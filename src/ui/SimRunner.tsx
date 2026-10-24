"use client";

import { useEffect } from "react";
import { burnTimes, setLive, sim } from "@/engine/runtime";
import { CATALOG } from "@/models/catalog";
import { useCircuitStore } from "@/store/circuitStore";
import { useSimStore } from "@/store/simulationStore";

/**
 * Solver step ceilings: `hard` keeps AC sources at ≥ 100 steps per cycle and gives every scope / logic analyser
 * at least ~100 steps per division, so waveforms stay smooth and accurate however fast the clock runs.
 */
function stepLimits(base: number): { base: number; hard: number } {
  const { components } = useCircuitStore.getState();
  let hard = Infinity;
  for (const c of components) {
    if (c.kind === "vac" || c.kind === "sigen") {
      const f = Number(c.params.frequency);
      if (Number.isFinite(f) && f > 0) hard = Math.min(hard, 1 / (f * 100));
    } else if (c.kind === "scope" || c.kind === "logic_analyzer") {
      const t = Number(c.params.tdiv);
      if (Number.isFinite(t) && t > 0) hard = Math.min(hard, t / 100);
    }
  }
  return { base: Math.min(base, hard), hard };
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

      const lim = stepLimits(ctl.baseDt);
      const dtBase = lim.base;
      let changed = false;

      if (ctl.stepRequests !== handledStep) {
        handledStep = ctl.stepRequests;
        for (let i = 0; i < 1; i++) sim.step(dtBase);
        changed = true;
      } else if (ctl.running && CATALOG && circuit.components.length > 0) {
        sim.advance(frameSec * ctl.speed, dtBase, 1500, 10, lim.hard);
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
