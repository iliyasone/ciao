using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace Ciao.Input;

/// <summary>
/// Windows input bridge for the Electron app, spoken to over stdin/stdout (one JSON object per line).
///
/// Events it emits:
///   {"type":"ready"}
///   {"type":"hotkey","down":true|false}   the push-to-talk key (never swallowed)
///   {"type":"escape"}                     Esc while armed — swallowed so the focused app never sees it
///   {"type":"other"}                      another key pressed while the hotkey is held (a shortcut, not dictation)
///   {"type":"mouse","down":true|false}    middle mouse button, when enabled — swallowed, so apps never see it
///
/// Commands it accepts (replies carry the same "id"):
///   {"id":1,"cmd":"foreground"}           → {"id":1,"hwnd":123,"title":"…","process":"…"}
///   {"id":2,"cmd":"paste","hwnd":123}     → Ctrl+V if that window is still in front (hwnd 0 = whatever is in front)
///                                           {"id":2,"ok":true} | {"id":2,"ok":false,"reason":"focus-changed","foreground":"…"}
///   {"cmd":"arm","on":true}               start/stop swallowing Esc
///   {"cmd":"mouse","on":true}             start/stop using the middle mouse button (also --middle-click at startup)
/// </summary>
static class Program
{
    static readonly BlockingCollection<string> Out = new();
    static volatile bool _armed;
    static volatile bool _hotkeyDown;
    static volatile bool _middleClick;
    static Keys _hotkey = Keys.RControlKey;

    [STAThread]
    static void Main(string[] args)
    {
        for (int i = 0; i < args.Length - 1; i++)
            if (args[i] == "--hotkey" && Enum.TryParse<Keys>(args[i + 1], out var k)) _hotkey = k;
        _middleClick = args.Contains("--middle-click");

        var stdout = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false)) { AutoFlush = true };
        new Thread(() => { foreach (var line in Out.GetConsumingEnumerable()) stdout.WriteLine(line); }) { IsBackground = true }.Start();

        using var hook = new Native.KeyboardHook(OnKey);
        using var mouse = new Native.MiddleButtonHook(OnMiddle);

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

        Emit(new JsonObject { ["type"] = "ready" });
        Application.Run(); // message loop that services the low-level hook
    }

    // Runs on the UI thread and must return fast, or Windows drops the hook.
    static bool OnKey(Keys key, bool down)
    {
        if (key == _hotkey)
        {
            if (down == _hotkeyDown) return false; // auto-repeat
            _hotkeyDown = down;
            Emit(new JsonObject { ["type"] = "hotkey", ["down"] = down });
            return false;
        }
        if (!down) return false;
        if (_armed && key == Keys.Escape)
        {
            Emit(new JsonObject { ["type"] = "escape" });
            return true;
        }
        if (_hotkeyDown) Emit(new JsonObject { ["type"] = "other" });
        return false;
    }

    static bool OnMiddle(bool down)
    {
        if (!_middleClick) return false;
        Emit(new JsonObject { ["type"] = "mouse", ["down"] = down });
        return true;
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
                    Emit(new JsonObject { ["id"] = id, ["ok"] = false, ["reason"] = "focus-changed", ["foreground"] = Native.DescribeWindow(front).Title });
                    break;
                }
                Native.SendPaste();
                Emit(new JsonObject { ["id"] = id, ["ok"] = true });
                break;
            }
            case "arm":
                _armed = msg["on"]?.GetValue<bool>() ?? false;
                break;
            case "mouse":
                _middleClick = msg["on"]?.GetValue<bool>() ?? false;
                break;
        }
    }

    static void Emit(JsonObject o) => Out.Add(o.ToJsonString(new JsonSerializerOptions { Encoder = System.Text.Encodings.Web.JavaScriptEncoder.UnsafeRelaxedJsonEscaping }));
}
