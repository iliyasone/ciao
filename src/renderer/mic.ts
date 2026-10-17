// Microphones as the renderers see them: the list Settings offers, and the constraints that open
// the one chosen there. A microphone is saved by its name, not its id: Chromium's ids change with
// the origin and after clearing site data, the names don't. "" means the system's default.

const AUDIO: MediaTrackConstraints = { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true };

/** Chromium's stand-ins for the system's default (and, on Windows, communications) device: not real devices. */
const ALIASES = new Set(["default", "communications"]);

/** The names of the connected microphones, in the system's order. Empty names (no permission yet) are left out. */
export async function listMics(): Promise<string[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  const names = devices.filter((d) => d.kind === "audioinput" && !ALIASES.has(d.deviceId) && d.label).map((d) => d.label);
  return [...new Set(names)];
}

/**
 * The device group a mic opened now would record from: the chosen one's if it is connected, else the
 * system default's. Undefined if unknown (no permission yet, no microphone).
 */
export async function micGroup(name: string): Promise<string | undefined> {
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  const chosen = name ? inputs.find((d) => !ALIASES.has(d.deviceId) && d.label === name) : undefined;
  return (chosen ?? inputs.find((d) => d.deviceId === "default") ?? inputs[0])?.groupId || undefined;
}

/** Opens the microphone named `name`, or the system's default if it is "" or not connected. */
export async function openMicStream(name: string): Promise<MediaStream> {
  if (name) {
    const device = (await navigator.mediaDevices.enumerateDevices()).find((d) => d.kind === "audioinput" && !ALIASES.has(d.deviceId) && d.label === name);
    if (device) {
      try {
        return await navigator.mediaDevices.getUserMedia({ audio: { ...AUDIO, deviceId: { exact: device.deviceId } } });
      } catch (e) {
        // Unplugged between the list and the open, or busy elsewhere: the default still records.
        console.warn(`microphone "${name}":`, errorText(e), "- using the default");
      }
    } else {
      console.warn(`microphone "${name}" is not connected - using the default`);
    }
  }
  return navigator.mediaDevices.getUserMedia({ audio: AUDIO });
}

/** An error from getUserMedia as text: some (OverconstrainedError, NotReadableError) come with an empty message. */
export function errorText(e: unknown): string {
  if (e instanceof Error || e instanceof DOMException) return e.message || e.name;
  return String(e);
}
