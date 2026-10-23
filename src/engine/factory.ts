import type { ComponentDef, PlacedComponent } from "@/models/types";
import {
  BjtDevice,
  CapacitorDevice,
  Device,
  DiodeArrayDevice,
  DiodeDevice,
  GateDevice,
  GroundDevice,
  InductorDevice,
  MeterDevice,
  MosfetDevice,
  NullDevice,
  OpAmpDevice,
  PotentiometerDevice,
  RegulatorDevice,
  RelayDevice,
  ResistorDevice,
  SwitchDevice,
  Timer555Device,
  VoltageSourceDevice,
  type DeviceState,
} from "./devices";
import { LcdDevice, McuDevice } from "./mcuDevice";
import {
  JfetDevice,
  OptoDevice,
  ScrDevice,
  ServoDevice,
  TransformerDevice,
  TriacDevice,
  UltrasonicDevice,
} from "./devicesExtra";

/** Instantiate the electrical model for a placed component. */
export function createDevice(comp: PlacedComponent, def: ComponentDef, nodes: number[], st: DeviceState): Device {
  switch (def.sim) {
    case "ground":
      return new GroundDevice(comp, def, nodes, st);
    case "resistor":
    case "load":
      return new ResistorDevice(comp, def, nodes, st);
    case "potentiometer":
      return new PotentiometerDevice(comp, def, nodes, st);
    case "capacitor":
      return new CapacitorDevice(comp, def, nodes, st);
    case "inductor":
      return new InductorDevice(comp, def, nodes, st);
    case "vsource":
      return new VoltageSourceDevice(comp, def, nodes, st);
    case "switch":
      return new SwitchDevice(comp, def, nodes, st);
    case "relay":
      return new RelayDevice(comp, def, nodes, st);
    case "diode":
      return new DiodeDevice(comp, def, nodes, st);
    case "diodeArray":
      return new DiodeArrayDevice(comp, def, nodes, st);
    case "bjt":
      return new BjtDevice(comp, def, nodes, st);
    case "mosfet":
      return new MosfetDevice(comp, def, nodes, st);
    case "opamp":
      return new OpAmpDevice(comp, def, nodes, st);
    case "regulator":
      return new RegulatorDevice(comp, def, nodes, st);
    case "gate":
      return new GateDevice(comp, def, nodes, st);
    case "timer555":
      return new Timer555Device(comp, def, nodes, st);
    case "meter":
      return new MeterDevice(comp, def, nodes, st);
    case "jfet":
      return new JfetDevice(comp, def, nodes, st);
    case "scr":
      return new ScrDevice(comp, def, nodes, st);
    case "triac":
      return new TriacDevice(comp, def, nodes, st);
    case "opto":
      return new OptoDevice(comp, def, nodes, st);
    case "transformer":
      return new TransformerDevice(comp, def, nodes, st);
    case "servo":
      return new ServoDevice(comp, def, nodes, st);
    case "mcu":
      return new McuDevice(comp, def, nodes, st);
    case "lcd":
      return new LcdDevice(comp, def, nodes, st);
    case "ultrasonic":
      return new UltrasonicDevice(comp, def, nodes, st);
    default:
      return new NullDevice(comp, def, nodes, st);
  }
}
