// Keyboards and mice read straight from /dev/input, which works the same under X11 and Wayland.
// Reading them needs the "input" group (see the README). Nothing is grabbed: every key and button
// still reaches the focused app.
import fs from "node:fs";
import path from "node:path";

// struct input_event on 64-bit: struct timeval (16 bytes), u16 type, u16 code, s32 value.
const EVENT_SIZE = 24;
const EV_SYN = 0;
const EV_KEY = 1;
const KEY_A = 30;
const BTN_MIDDLE = 0x112;

export type KeyListener = (code: number, value: number) => void;

/** Writes one event and the SYN_REPORT that ends it. */
export function writeEvent(fd: number, type: number, code: number, value: number): void {
  const buf = Buffer.alloc(EVENT_SIZE * 2);
  buf.writeUInt16LE(type, 16);
  buf.writeUInt16LE(code, 18);
  buf.writeInt32LE(value, 20);
  buf.writeUInt16LE(EV_SYN, EVENT_SIZE + 16);
  fs.writeSync(fd, buf);
}

/** The key bitmap from sysfs: hex words, most significant first, each one machine word. */
function hasKey(bitmap: string, code: number): boolean {
  const words = bitmap.trim().split(/\s+/).reverse();
  const word = words[Math.floor(code / 64)];
  return word !== undefined && ((BigInt(`0x${word}`) >> BigInt(code % 64)) & 1n) === 1n;
}

/** A keyboard (has letter keys) or a mouse with a middle button; skips our own virtual keyboard. */
function interesting(event: string, skipName: string): boolean {
  const dir = `/sys/class/input/${event}/device`;
  try {
    if (fs.readFileSync(path.join(dir, "name"), "utf8").trim() === skipName) return false;
    const keys = fs.readFileSync(path.join(dir, "capabilities", "key"), "utf8");
    return hasKey(keys, KEY_A) || hasKey(keys, BTN_MIDDLE);
  } catch {
    return false;
  }
}

/**
 * Follows every keyboard and mouse, including ones plugged in later. Reports key and button
 * events (value 1 = down, 0 = up, 2 = auto-repeat) and, after each scan, how many devices it
 * reads and how many it may not open.
 */
export class Devices {
  private readonly open = new Map<string, fs.ReadStream>();
  private readonly denied = new Set<string>();
  private rescan: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly onKey: KeyListener,
    private readonly onStatus: (reading: number, denied: number) => void,
    private readonly skipName: string,
  ) {}

  start(): void {
    this.scan();
    fs.watch("/dev/input", () => {
      if (this.rescan) clearTimeout(this.rescan);
      this.rescan = setTimeout(() => this.scan(), 500); // udev fixes the permissions just after the node appears
    });
  }

  private scan(): void {
    this.denied.clear();
    for (const event of fs.readdirSync("/dev/input").filter((f) => f.startsWith("event"))) {
      const file = `/dev/input/${event}`;
      if (this.open.has(file) || !interesting(event, this.skipName)) continue;
      try {
        fs.accessSync(file, fs.constants.R_OK);
      } catch {
        this.denied.add(file);
        continue;
      }
      this.follow(file);
    }
    this.onStatus(this.open.size, this.denied.size);
  }

  private follow(file: string): void {
    // Each blocked read holds a libuv thread; the helper raises UV_THREADPOOL_SIZE for that.
    const stream = fs.createReadStream(file, { highWaterMark: EVENT_SIZE * 64 });
    let rest: Buffer = Buffer.alloc(0);
    stream.on("data", (chunk) => {
      const buf = rest.length ? Buffer.concat([rest, chunk as Buffer]) : (chunk as Buffer);
      let o = 0;
      for (; o + EVENT_SIZE <= buf.length; o += EVENT_SIZE)
        if (buf.readUInt16LE(o + 16) === EV_KEY) this.onKey(buf.readUInt16LE(o + 18), buf.readInt32LE(o + 20));
      rest = buf.subarray(o);
    });
    stream.on("error", () => this.open.delete(file)); // unplugged
    stream.on("close", () => this.open.delete(file));
    this.open.set(file, stream);
  }
}
