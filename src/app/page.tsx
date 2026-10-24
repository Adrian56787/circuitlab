"use client";

import { useEffect } from "react";
import { PRESETS } from "@/presets/presets";
import { restoreAutosave, startAutosave } from "@/storage/autosave";
import { useCircuitStore } from "@/store/circuitStore";
import { useSettingsStore } from "@/store/settingsStore";
import { CircuitCanvas } from "@/ui/canvas/CircuitCanvas";
import { Inspector } from "@/ui/panels/Inspector";
import { ResistorCalc } from "@/ui/panels/ResistorCalc";
import { Dock } from "@/ui/panels/Dock";
import { Sidebar } from "@/ui/panels/Sidebar";
import { CanvasHelp } from "@/ui/panels/FloatingHelp";
import { PlacementHud } from "@/ui/panels/PlacementHud";
import { SettingsModal } from "@/ui/panels/SettingsModal";
import { FailureLog, StatusBar, Toasts } from "@/ui/panels/StatusBar";
import { Toolbar, fitView } from "@/ui/panels/Toolbar";
import { SimRunner } from "@/ui/SimRunner";

export default function Page(): React.JSX.Element {
  // persisted preferences are read after mount so server and first client render match
  useEffect(() => {
    void useSettingsStore.persist.rehydrate();
  }, []);

  // Start with a small working circuit so the canvas is never empty on first load.
  useEffect(() => {
    if (useCircuitStore.getState().components.length === 0) {
      if (!restoreAutosave()) useCircuitStore.getState().load(PRESETS[0]!.build());
      requestAnimationFrame(fitView);
    }
    return startAutosave();
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-bg text-ink">
      <SimRunner />
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <Sidebar />
        <main className="flex min-w-0 flex-1 flex-col">
          <div id="canvas-host" className="relative min-h-0 flex-1">
            <CircuitCanvas />
            <PlacementHud />
          </div>
          <Dock />
        </main>
        <Inspector />
      </div>
      <StatusBar />
      <ResistorCalc />
      <Toasts />
      <FailureLog />
      <CanvasHelp />
      <SettingsModal />
    </div>
  );
}
