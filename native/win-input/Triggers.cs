namespace Ciao.Input;

/// <summary>
/// A dictation trigger, written as "+"-separated tokens: optional modifiers (Ctrl, Alt, Shift, Win)
/// followed by one key (a System.Windows.Forms.Keys name) or mouse button (MButton, XButton1, XButton2).
/// Examples: "RControlKey", "MButton", "Ctrl+Alt+Space", "Ctrl+XButton1", "F13".
/// </summary>
sealed class Trigger
{
    public required string Spec { get; init; }
    public Keys Key { get; init; }
    public string? Mouse { get; init; }
    public bool Ctrl { get; init; }
    public bool Alt { get; init; }
    public bool Shift { get; init; }
    public bool Win { get; init; }

    /// <summary>Currently held down (between its down and up events).</summary>
    public bool Active { get; set; }

    public static readonly string[] MouseButtons = ["MButton", "XButton1", "XButton2"];

    /// <summary>A bare modifier like Right Ctrl: never swallowed, so Ctrl+C keeps working.</summary>
    public bool IsLoneModifier => Mouse is null && IsModifier(Key) && !Ctrl && !Alt && !Shift && !Win;

    public static Trigger? Parse(string spec)
    {
        var parts = spec.Split('+', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries);
        if (parts.Length == 0) return null;
        bool ctrl = false, alt = false, shift = false, win = false;
        foreach (var m in parts[..^1])
        {
            switch (m.ToLowerInvariant())
            {
                case "ctrl": ctrl = true; break;
                case "alt": alt = true; break;
                case "shift": shift = true; break;
                case "win": win = true; break;
                default: return null;
            }
        }
        var last = parts[^1];
        if (MouseButtons.Contains(last, StringComparer.OrdinalIgnoreCase))
            return new Trigger { Spec = spec, Mouse = MouseButtons.First(b => b.Equals(last, StringComparison.OrdinalIgnoreCase)), Ctrl = ctrl, Alt = alt, Shift = shift, Win = win };
        if (!Enum.TryParse<Keys>(last, ignoreCase: true, out var key) || key == Keys.None) return null;
        return new Trigger { Spec = spec, Key = key, Ctrl = ctrl, Alt = alt, Shift = shift, Win = win };
    }

    /// <summary>Exactly the required modifiers are down (so Ctrl+Space doesn't fire on Ctrl+Shift+Space).</summary>
    public bool ModifiersMatch(Modifiers now) =>
        IsLoneModifier || (now.Ctrl == Ctrl && now.Alt == Alt && now.Shift == Shift && now.Win == Win);

    public static bool IsModifier(Keys k) => k is Keys.LControlKey or Keys.RControlKey or Keys.ControlKey
        or Keys.LShiftKey or Keys.RShiftKey or Keys.ShiftKey or Keys.LMenu or Keys.RMenu or Keys.Menu or Keys.LWin or Keys.RWin;
}

readonly record struct Modifiers(bool Ctrl, bool Alt, bool Shift, bool Win)
{
    public string Prefix =>
        (Ctrl ? "Ctrl+" : "") + (Alt ? "Alt+" : "") + (Shift ? "Shift+" : "") + (Win ? "Win+" : "");

    public static Modifiers Of(IEnumerable<Keys> down)
    {
        var set = down.ToHashSet();
        return new Modifiers(
            set.Contains(Keys.LControlKey) || set.Contains(Keys.RControlKey),
            set.Contains(Keys.LMenu) || set.Contains(Keys.RMenu),
            set.Contains(Keys.LShiftKey) || set.Contains(Keys.RShiftKey),
            set.Contains(Keys.LWin) || set.Contains(Keys.RWin));
    }
}
