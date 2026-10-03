using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Ciao.Input;

/// <summary>
/// Windows input bridge for the Electron app, spoken to over stdin/stdout (one JSON object per line).
/// Start it with one "--trigger SPEC" per dictation trigger (see <see cref="Trigger"/> for the syntax).
///
/// Events it emits:
///   {"type":"ready","triggers":[…]}
///   {"type":"trigger","down":true|false,"spec":"…"}  a trigger pressed/released
///   {"type":"escape"}                                  Esc while armed — swallowed so the focused app never sees it
///   {"type":"other"}                                   another key while a lone-modifier trigger is held (a shortcut, not dictation)
///   {"type":"captured","spec":"…"|null}                result of a capture (null = cancelled with Esc)
///   {"type":"permission","accessibility":bool}         macOS helper only (native/mac-input): whether the event tap is up
///
/// Commands it accepts (replies carry the same "id"):
///   {"id":1,"cmd":"foreground"}           → {"id":1,"hwnd":123,"title":"…","process":"…"}
///   {"id":2,"cmd":"paste","hwnd":123}     → Ctrl+V if that window is still in front (hwnd 0 = whatever is in front)
///                                           {"id":2,"ok":true} | {"id":2,"ok":false,"reason":"focus-changed","foreground":"…",
///                                            "foregroundProcess":"…","targetExists":bool,"targetOnCurrentDesktop":bool|null}
///   {"cmd":"arm","on":true}               start/stop swallowing Esc
///   {"cmd":"triggers","list":["…"]}       replace the triggers
///   {"cmd":"capture","on":true}           report the next key, combo or mouse button as "captured" (swallowing it)
/// </summary>
static class Program
{
    static readonly BlockingCollection<string> Out = new();
    static volatile bool _armed;
    static volatile Trigger[] _triggers = [];

    // Capture state (touched only on the hook thread, except _capturing which stdin flips).
    static volatile bool _capturing;
    static readonly HashSet<Keys> _captureMods = [];
    static Keys? _loneModifier;
    static Keys? _swallowKeyUp;
    static string? _swallowMouseUp;

    [STAThread]
    static void Main(string[] args)
    {
        var specs = new List<string>();
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == "--trigger") specs.Add(args[i + 1]);
        SetTriggers(specs);
        Native.KeyboardHook.AcceptInjected = args.Contains("--accept-injected");

        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        new Thread(() => { foreach (var line in Out.GetConsumingEnumerable()) stdout.WriteLine(line); }) { IsBackground = true }.Start();

        using var keyboard = new Native.KeyboardHook(OnKey);
        using var mouse = new Native.MouseButtonHook(OnMouse);

        var stdin = new StreamReader(Console.OpenStandardInput(), Encoding.UTF8);
        new Thread(() =>
        {
            while (stdin.ReadLine() is { } line)
            {
                try { Handle(line); }
                catch (Exception e) { Emit(new JsonObject { ["type"] = "log", ["message"] = e.Message }); }
            }
            Application.Exit(); // parent closed the pipe
        }) { IsBackground = true }.Start();

        Emit(new JsonObject { ["type"] = "ready", ["triggers"] = new JsonArray(_triggers.Select(t => (JsonNode)t.Spec).ToArray()) });
        Application.Run(); // message loop that services the low-level hooks
    }

    static void SetTriggers(IEnumerable<string> specs)
    {
        var parsed = new List<Trigger>();
        foreach (var spec in specs)
        {
            if (Trigger.Parse(spec) is { } t) parsed.Add(t);
            else Emit(new JsonObject { ["type"] = "log", ["message"] = $"bad trigger: {spec}" });
        }
        _triggers = parsed.ToArray();
    }

    // Hook callbacks run on the UI thread and must return fast, or Windows drops the hook.

    static bool OnKey(Keys key, bool down)
    {
        if (_capturing) return CaptureKey(key, down);
        if (!down && _swallowKeyUp == key)
        {
            _swallowKeyUp = null;
            return true;
        }

        bool swallow = false;
        var mods = Native.CurrentModifiers();
        foreach (var t in _triggers)
        {
            if (t.Mouse is not null || t.Key != key) continue;
            if (down)
            {
                if (!t.Active && t.ModifiersMatch(mods))
                {
                    t.Active = true;
                    Emit(new JsonObject { ["type"] = "trigger", ["down"] = true, ["spec"] = t.Spec });
                }
                if (t.Active && !t.IsLoneModifier) swallow = true; // also eats auto-repeat
            }
            else if (t.Active)
            {
                t.Active = false;
                Emit(new JsonObject { ["type"] = "trigger", ["down"] = false, ["spec"] = t.Spec });
                if (!t.IsLoneModifier) swallow = true;
            }
        }
        if (swallow || !down) return swallow;

        if (_armed && key == Keys.Escape)
        {
            Emit(new JsonObject { ["type"] = "escape" });
            return true;
        }
        if (_triggers.Any(t => t.Active && t.IsLoneModifier && t.Key != key)) Emit(new JsonObject { ["type"] = "other" });
        return false;
    }

    static bool OnMouse(string button, bool down)
    {
        if (_capturing)
        {
            if (down)
            {
                EndCapture(Modifiers.Of(_captureMods).Prefix + button);
                _swallowMouseUp = button;
            }
            return true;
        }
        if (!down && _swallowMouseUp == button)
        {
            _swallowMouseUp = null;
            return true;
        }

        bool swallow = false;
        var mods = Native.CurrentModifiers();
        foreach (var t in _triggers)
        {
            if (t.Mouse != button) continue;
            if (down && !t.Active && t.ModifiersMatch(mods))
            {
                t.Active = true;
                Emit(new JsonObject { ["type"] = "trigger", ["down"] = true, ["spec"] = t.Spec });
                swallow = true;
            }
            else if (!down && t.Active)
            {
                t.Active = false;
                Emit(new JsonObject { ["type"] = "trigger", ["down"] = false, ["spec"] = t.Spec });
                swallow = true;
            }
        }
        return swallow;
    }

    /// <summary>
    /// Everything is swallowed while capturing. A modifier pressed and released alone becomes a
    /// lone-modifier trigger (e.g. "RControlKey"); otherwise the first non-modifier key or mouse
    /// button, with the modifiers held at that moment, becomes the trigger. Esc alone cancels.
    /// </summary>
    static bool CaptureKey(Keys key, bool down)
    {
        if (Trigger.IsModifier(key))
        {
            if (down)
            {
                // AltGr arrives as a fake Left Ctrl followed by Right Alt: keep only the Alt.
                if (key == Keys.RMenu && _loneModifier == Keys.LControlKey && _captureMods.Count == 1)
                {
                    _captureMods.Remove(Keys.LControlKey);
                    _loneModifier = null;
                }
                _captureMods.Add(key);
                _loneModifier ??= key;
            }
            else
            {
                _captureMods.Remove(key);
                if (_loneModifier == key) EndCapture(key.ToString());
            }
            return true;
        }
        if (!down) return true;
        if (key == Keys.Escape && _captureMods.Count == 0)
        {
            EndCapture(null);
            return true;
        }
        EndCapture(Modifiers.Of(_captureMods).Prefix + key);
        _swallowKeyUp = key;
        return true;
    }

    static void StartCapture()
    {
        _captureMods.Clear();
        _loneModifier = null;
        _capturing = true;
    }

    static void EndCapture(string? spec)
    {
        _capturing = false;
        _captureMods.Clear();
        _loneModifier = null;
        Emit(new JsonObject { ["type"] = "captured", ["spec"] = spec });
    }

    static void Handle(string line)
    {
        var msg = JsonNode.Parse(line)!.AsObject();
        var id = msg["id"]?.GetValue<int>();
        switch (msg["cmd"]?.GetValue<string>())
        {
            case "foreground":
            {
                var hwnd = Native.GetForegroundWindow();
                var (title, process) = Native.DescribeWindow(hwnd);
                Emit(new JsonObject { ["id"] = id, ["hwnd"] = hwnd.ToInt64(), ["title"] = title, ["process"] = process });
                break;
            }
            case "paste":
            {
                var wanted = new IntPtr(msg["hwnd"]?.GetValue<long>() ?? 0);
                var front = Native.GetForegroundWindow();
                if (wanted != IntPtr.Zero && front != wanted)
                {
                    var (title, process) = Native.DescribeWindow(front);
                    Emit(new JsonObject
                    {
                        ["id"] = id, ["ok"] = false, ["reason"] = "focus-changed", ["foreground"] = title, ["foregroundProcess"] = process,
                        // Why focus moved: the window was closed, or the user switched to another virtual desktop.
                        ["targetExists"] = Native.IsWindow(wanted), ["targetOnCurrentDesktop"] = Native.IsOnCurrentDesktop(wanted),
                    });
                    break;
                }
                Native.SendPaste();
                Emit(new JsonObject { ["id"] = id, ["ok"] = true });
                break;
            }
            case "arm":
                _armed = msg["on"]?.GetValue<bool>() ?? false;
                break;
            case "triggers":
                SetTriggers(msg["list"]?.AsArray().Select(n => n!.GetValue<string>()) ?? []);
                break;
            case "capture":
                if (msg["on"]?.GetValue<bool>() ?? false) StartCapture();
                else _capturing = false;
                break;
        }
    }

    static void Emit(JsonObject o) => Out.Add(o.ToJsonString(new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
}
