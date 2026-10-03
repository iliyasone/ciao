// Ctrl+V for Wayland, where an app can't type into another app's window: a virtual keyboard made
// through /dev/uinput, which the compositor treats like a real one. Needs write access to
// /dev/uinput (see the udev rule in the README).
import fs from "node:fs";
import { writeEvent } from "./evdev";

type Fn = (...args: unknown[]) => unknown;
interface Koffi {
  load(file: string): { func(signature: string): Fn };
}

export const DEVICE_NAME = "Ciao virtual keyboard";

// linux/uinput.h, linux/input-event-codes.h
const UI_SET_EVBIT = 0x40045564;
const UI_SET_KEYBIT = 0x40045565;
const UI_DEV_SETUP = 0x405c5503;
const UI_DEV_CREATE = 0x5501;
const EV_KEY = 1;
const BUS_VIRTUAL = 0x06;
const KEY_LEFTCTRL = 29;
const KEY_LEFTSHIFT = 42;
const KEY_V = 47;

export class Uinput {
  private constructor(private readonly fd: number) {}

  /** null without access to /dev/uinput. */
  static open(koffi: Koffi): Uinput | null {
    let fd: number;
    try {
      fd = fs.openSync("/dev/uinput", fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
    } catch {
      return null;
    }
    const ioctl = koffi.load("libc.so.6").func("int ioctl(int, unsigned long, ...)");
    ioctl(fd, UI_SET_EVBIT, "int", EV_KEY);
    for (const key of [KEY_LEFTCTRL, KEY_LEFTSHIFT, KEY_V]) ioctl(fd, UI_SET_KEYBIT, "int", key);
    // struct uinput_setup { struct input_id { u16 bustype, vendor, product, version }; char name[80]; u32 ff_effects_max; }
    const setup = Buffer.alloc(92);
    setup.writeUInt16LE(BUS_VIRTUAL, 0);
    setup.write(DEVICE_NAME, 8);
    if (ioctl(fd, UI_DEV_SETUP, "void *", setup) !== 0 || ioctl(fd, UI_DEV_CREATE) !== 0) {
      fs.closeSync(fd);
      return null;
    }
    return new Uinput(fd);
  }

  /** Ctrl+V, or Ctrl+Shift+V (terminals). */
  paste(shift: boolean): void {
    const keys = [KEY_LEFTCTRL, ...(shift ? [KEY_LEFTSHIFT] : []), KEY_V];
    for (const k of keys) writeEvent(this.fd, EV_KEY, k, 1);
    for (const k of keys.reverse()) writeEvent(this.fd, EV_KEY, k, 0);
  }
}
