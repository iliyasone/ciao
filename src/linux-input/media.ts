// Pauses the media players that are playing (Spotify, a browser tab, any MPRIS player) and later resumes just
// those, over the session D-Bus with dbus-send (it comes with D-Bus itself, so desktops have it). Calls run one
// after another, so a resume always follows the pause it undoes.
import { execFile } from "node:child_process";

const PLAYER = "org.mpris.MediaPlayer2.Player";

function dbus(dest: string, path: string, method: string, ...args: string[]): Promise<string> {
  return new Promise((resolve, reject) =>
    execFile("dbus-send", ["--session", "--print-reply", `--dest=${dest}`, path, method, ...args], { timeout: 2000 }, (e, out) =>
      e ? reject(e) : resolve(out),
    ),
  );
}

const status = async (name: string): Promise<string | undefined> =>
  /"(\w+)"/.exec(await dbus(name, "/org/mpris/MediaPlayer2", "org.freedesktop.DBus.Properties.Get", `string:${PLAYER}`, "string:PlaybackStatus"))?.[1];

export class Media {
  /** The bus names of the players we paused. */
  private paused: string[] = [];
  private queue = Promise.resolve();

  constructor(private readonly log: (message: string) => void) {}

  set(pause: boolean): void {
    this.queue = this.queue
      .then(() => (pause ? this.pause() : this.resume()))
      .catch((e: Error) => this.log(`media: ${e.message}`));
  }

  private async pause(): Promise<void> {
    const names = await dbus("org.freedesktop.DBus", "/org/freedesktop/DBus", "org.freedesktop.DBus.ListNames");
    for (const [, name] of names.matchAll(/"(org\.mpris\.MediaPlayer2\.[^"]+)"/g)) {
      try {
        if ((await status(name!)) !== "Playing") continue;
        await dbus(name!, "/org/mpris/MediaPlayer2", `${PLAYER}.Pause`);
        this.paused.push(name!);
      } catch {
        // A player that quit or doesn't answer: leave it.
      }
    }
  }

  private async resume(): Promise<void> {
    const paused = this.paused;
    this.paused = [];
    for (const name of paused) {
      try {
        // Still paused: the user didn't start or stop it themselves meanwhile.
        if ((await status(name)) === "Paused") await dbus(name, "/org/mpris/MediaPlayer2", `${PLAYER}.Play`);
      } catch {
        // Gone meanwhile.
      }
    }
  }
}
