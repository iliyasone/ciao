using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

namespace Ciao.Input;

static class Native
{
    const int WH_KEYBOARD_LL = 13;
    const int WM_KEYDOWN = 0x0100, WM_KEYUP = 0x0101, WM_SYSKEYDOWN = 0x0104, WM_SYSKEYUP = 0x0105;
    const uint LLKHF_INJECTED = 0x10;

    [StructLayout(LayoutKind.Sequential)]
    struct KBDLLHOOKSTRUCT
    {
        public uint vkCode, scanCode, flags, time;
        public IntPtr dwExtraInfo;
    }

    delegate IntPtr LowLevelKeyboardProc(int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowsHookEx(int idHook, LowLevelKeyboardProc lpfn, IntPtr hMod, uint dwThreadId);

    [DllImport("user32.dll")]
    static extern bool UnhookWindowsHookEx(IntPtr hhk);

    [DllImport("user32.dll")]
    static extern IntPtr CallNextHookEx(IntPtr hhk, int nCode, IntPtr wParam, IntPtr lParam);

    [DllImport("kernel32.dll")]
    static extern IntPtr GetModuleHandle(string? lpModuleName);

    /// <summary>
    /// Global low-level keyboard hook. The handler returns true to swallow the key.
    /// Injected keys (our own Ctrl+V) are passed through untouched.
    /// </summary>
    public sealed class KeyboardHook : IDisposable
    {
        readonly LowLevelKeyboardProc _proc; // kept alive: the OS holds only a raw pointer
        readonly IntPtr _hook;
        readonly Func<Keys, bool, bool> _handler;

        public KeyboardHook(Func<Keys, bool, bool> handler)
        {
            _handler = handler;
            _proc = Callback;
            _hook = SetWindowsHookEx(WH_KEYBOARD_LL, _proc, GetModuleHandle(null), 0);
            if (_hook == IntPtr.Zero) throw new InvalidOperationException("SetWindowsHookEx failed: " + Marshal.GetLastWin32Error());
        }

        IntPtr Callback(int nCode, IntPtr wParam, IntPtr lParam)
        {
            if (nCode >= 0)
            {
                var k = Marshal.PtrToStructure<KBDLLHOOKSTRUCT>(lParam);
                if ((k.flags & LLKHF_INJECTED) == 0)
                {
                    int msg = (int)wParam;
                    bool down = msg is WM_KEYDOWN or WM_SYSKEYDOWN;
                    bool up = msg is WM_KEYUP or WM_SYSKEYUP;
                    if ((down || up) && _handler((Keys)k.vkCode, down)) return 1;
                }
            }
            return CallNextHookEx(_hook, nCode, wParam, lParam);
        }

        public void Dispose() => UnhookWindowsHookEx(_hook);
    }

    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);

    public static (string Title, string Process) DescribeWindow(IntPtr hwnd)
    {
        var sb = new StringBuilder(256);
        GetWindowText(hwnd, sb, sb.Capacity);
        string proc = "";
        try
        {
            GetWindowThreadProcessId(hwnd, out var pid);
            proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName;
        }
        catch (Exception)
        {
            // Process may have exited; the title is enough.
        }
        return (sb.ToString(), proc);
    }

    [StructLayout(LayoutKind.Sequential)]
    struct INPUT
    {
        public uint type;
        public KEYBDINPUT ki;
        public uint pad1, pad2; // the union is sized for MOUSEINPUT
    }

    [StructLayout(LayoutKind.Sequential)]
    struct KEYBDINPUT
    {
        public ushort wVk, wScan;
        public uint dwFlags, time;
        public IntPtr dwExtraInfo;
    }

    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);

    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int vKey);

    const uint INPUT_KEYBOARD = 1, KEYEVENTF_KEYUP = 0x0002;

    static INPUT Key(Keys k, bool up) => new()
    {
        type = INPUT_KEYBOARD,
        ki = new KEYBDINPUT { wVk = (ushort)k, dwFlags = up ? KEYEVENTF_KEYUP : 0 },
    };

    /// <summary>Sends Ctrl+V, first releasing any modifier the user may still be holding (e.g. Alt+Shift from the paste-last hotkey).</summary>
    public static void SendPaste()
    {
        var inputs = new List<INPUT>();
        foreach (var m in new[] { Keys.LControlKey, Keys.RControlKey, Keys.LShiftKey, Keys.RShiftKey, Keys.LMenu, Keys.RMenu, Keys.LWin, Keys.RWin })
            if ((GetAsyncKeyState((int)m) & 0x8000) != 0) inputs.Add(Key(m, up: true));
        inputs.Add(Key(Keys.ControlKey, false));
        inputs.Add(Key(Keys.V, false));
        inputs.Add(Key(Keys.V, true));
        inputs.Add(Key(Keys.ControlKey, true));
        SendInput((uint)inputs.Count, inputs.ToArray(), Marshal.SizeOf<INPUT>());
    }
}
