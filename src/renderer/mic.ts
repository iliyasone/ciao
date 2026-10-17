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
 * What the devices connected now mean for an open mic track: "gone" (its device was removed, even if
 * the track didn't end), "switch" (another device is the one to record from now), or null (keep it).
 */
export async function checkTrack(track: MediaStreamTrack, name: string): Promise<"gone" | "switch" | null> {
  const inputs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput");
  const real = inputs.filter((d) => !ALIASES.has(d.deviceId));
  const { deviceId, groupId } = track.getSettings();
  if (deviceId && !ALIASES.has(deviceId) && !real.some((d) => d.deviceId === deviceId)) return "gone";
  // By name: two inputs of one device (a headset jack and the built-in array) can share a group.
  const chosen = name ? real.find((d) => d.label === name) : undefined;
  if (chosen) return track.label === name ? null : "switch";
  // The default, by group: the "default" entry's group is the device it stands for; speakers or
  // another mic coming and going leave it alone. Two inputs of one sound card share a group, so a
  // track on the "default" entry is also checked by name: Windows and macOS put the device's name in
  // it ("Default - Headset Microphone"); on Linux it stays "Default", and the sound server moves the stream itself.
  const fallback = inputs.find((d) => d.deviceId === "default") ?? real[0];
  if (!groupId || fallback?.groupId !== groupId) {
    // On the default and no device of its group is left: unplugged, even if the stream only stalled.
    const left = groupId && ALIASES.has(deviceId ?? "") && !real.some((d) => d.groupId === groupId);
    return left ? "gone" : "switch";
  }
  return deviceId === "default" && fallback.label !== track.label ? "switch" : null;
}

/** The name of the device a track records from: for one opened on the default, the real device's, not "Default". */
export async function trackName(track: MediaStreamTrack): Promise<string> {
  const { deviceId, groupId } = track.getSettings();
  if (!deviceId || !ALIASES.has(deviceId)) return track.label;
  const real = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === "audioinput" && !ALIASES.has(d.deviceId));
  // "Default - Headset Microphone (USB)" holds "Microphone (USB)" too: the longest name is the one.
  const named = real.filter((d) => d.label && track.label.endsWith(d.label)).sort((a, b) => b.label.length - a.label.length)[0];
  const device = named ?? real.find((d) => d.groupId === groupId);
  return device?.label || track.label;
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
