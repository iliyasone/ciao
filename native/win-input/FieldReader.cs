using System.Collections.Concurrent;
using System.Runtime.InteropServices;

namespace Ciao.Input;

/// <summary>
/// Reads the text of the focused editable field through UI Automation (the COM client, CUIAutomation8).
/// A UIA call goes into the target app and can hang as long as that app does, so the calls run on a
/// worker thread — MTA, as UIA clients should, and never the hook thread, whose hooks Windows drops if
/// it stalls — and every read answers within <see cref="Timeout"/> whatever the app does.
/// </summary>
static class FieldReader
{
    public const int MaxLength = 100_000;
    static readonly TimeSpan Timeout = TimeSpan.FromMilliseconds(800);

    public readonly record struct Result(string? Text, string? Reason);

    static readonly object Lock = new();
    static Worker _worker = new();

    /// <summary>Starts the worker and its UIA client ahead of the first read: an Enter read can't wait for them.</summary>
    public static void Warm()
    {
        lock (Lock) _ = _worker;
    }

    /// <summary>hwnd 0 = whatever is in front. Completes within about <see cref="Timeout"/>, never faults.</summary>
    public static Task<Result> Read(IntPtr wanted)
    {
        if (wanted != IntPtr.Zero && Native.GetForegroundWindow() != wanted)
            return Task.FromResult(new Result(null, "focus-changed"));

        var done = new TaskCompletionSource<Result>(TaskCreationOptions.RunContinuationsAsynchronously);
        Worker w;
        lock (Lock) w = _worker;
        w.Post(uia =>
        {
            if (!done.Task.IsCompleted) done.TrySetResult(ReadFocused(uia)); // skip reads that already timed out
        });
        Task.Delay(Timeout).ContinueWith(_ =>
        {
            if (!done.TrySetResult(new Result(null, "timeout"))) return;
            // The worker is stuck in a hung app: let it finish on its own and give later reads a fresh one.
            lock (Lock)
            {
                if (_worker != w) return;
                w.Retire();
                _worker = new Worker();
            }
        }, TaskScheduler.Default);
        return done.Task;
    }

    sealed class Worker
    {
        readonly BlockingCollection<Action<IUIAutomation2?>> _jobs = new();

        public Worker()
        {
            var thread = new Thread(Run) { IsBackground = true, Name = "uia" };
            thread.SetApartmentState(ApartmentState.MTA);
            thread.Start();
        }

        public void Post(Action<IUIAutomation2?> job)
        {
            try { _jobs.Add(job); }
            catch (InvalidOperationException) { } // retired meanwhile: the read times out
        }

        public void Retire() => _jobs.CompleteAdding();

        void Run()
        {
            IUIAutomation2? uia = null;
            try
            {
                uia = (IUIAutomation2)new CUIAutomation8();
                // UIA's own defaults (2 s to connect, 20 s per call) would keep a retired worker around for long.
                // A call short enough that a slow (not hung) app fails inside the read's own limit, rather than
                // retiring a worker on every read.
                uia.put_ConnectionTimeout(700);
                uia.put_TransactionTimeout(250);
            }
            catch (Exception)
            {
                // No UIA (stripped-down Windows): every read answers "unsupported".
            }
            foreach (var job in _jobs.GetConsumingEnumerable()) job(uia);
            if (uia is not null) Marshal.FinalReleaseComObject(uia);
        }
    }

    const int UIA_TextPatternId = 10014;
    const int UIA_ControlTypePropertyId = 30003, UIA_IsKeyboardFocusablePropertyId = 30009, UIA_IsPasswordPropertyId = 30019,
        UIA_IsTextPatternAvailablePropertyId = 30040, UIA_IsValuePatternAvailablePropertyId = 30043,
        UIA_ValueValuePropertyId = 30045, UIA_ValueIsReadOnlyPropertyId = 30046;
    const int UIA_IsReadOnlyAttributeId = 40015;
    const int UIA_EditControlTypeId = 50004, UIA_DocumentControlTypeId = 50030;
    const int UIA_E_TIMEOUT = unchecked((int)0x80131505);

    static readonly Result NoField = new(null, "no-field");

    static Result ReadFocused(IUIAutomation2? uia)
    {
        if (uia is null) return new(null, "unsupported");
        IUIAutomationElement? el = null;
        object? pattern = null;
        IUIAutomationTextRange? range = null;
        try
        {
            el = uia.GetFocusedElement();
            if (el is null || el.GetCurrentPropertyValue(UIA_IsPasswordPropertyId) is true) return NoField;

            bool editableValue = el.GetCurrentPropertyValue(UIA_IsValuePatternAvailablePropertyId) is true
                && el.GetCurrentPropertyValue(UIA_ValueIsReadOnlyPropertyId) is false;
            // An empty Value may just mean the control keeps its text elsewhere (rich edits): then try TextPattern.
            if (editableValue && el.GetCurrentPropertyValue(UIA_ValueValuePropertyId) is string { Length: > 0 } value) return Text(value);

            if (el.GetCurrentPropertyValue(UIA_IsTextPatternAvailablePropertyId) is true)
            {
                var type = el.GetCurrentPropertyValue(UIA_ControlTypePropertyId) as int?;
                if (type is not (UIA_EditControlTypeId or UIA_DocumentControlTypeId)
                    && el.GetCurrentPropertyValue(UIA_IsKeyboardFocusablePropertyId) is not true) return NoField;
                pattern = el.GetCurrentPattern(UIA_TextPatternId);
                range = ((IUIAutomationTextPattern)pattern).get_DocumentRange();
                // A browser page itself is a focusable Document too: take it only if it says it is editable. "Mixed"
                // or "not supported" come back as objects; an Edit is editable by nature, so it gets the benefit of the doubt.
                var readOnly = range.GetAttributeValue(UIA_IsReadOnlyAttributeId);
                if (readOnly is true || (readOnly is not false && type != UIA_EditControlTypeId)) return NoField;
                return Text(range.GetText(MaxLength + 1) ?? "");
            }
            return editableValue ? Text("") : NoField;
        }
        catch (COMException e) when (e.HResult == UIA_E_TIMEOUT)
        {
            return new(null, "timeout");
        }
        catch (Exception)
        {
            return NoField; // element gone, provider error, pattern missing after all
        }
        finally
        {
            // Release now rather than at GC: the target app keeps its provider objects alive while we hold them.
            foreach (var o in new[] { range, pattern, el })
                if (o is not null) Marshal.FinalReleaseComObject(o);
        }
    }

    static Result Text(string s) =>
        s.Length > MaxLength ? new(null, "too-long") : new(s.Replace("\r\n", "\n").Replace('\r', '\n'), null);

    // Minimal COM declarations from UIAutomationClient.idl. Only the vtable slots up to the last method used are
    // declared; placeholders (_N) keep the order and must never be called.

    [ComImport, Guid("e22ad333-b25f-460c-83d0-0581107395c9")]
    class CUIAutomation8;

    [ComImport, Guid("34723aff-0c9d-49d0-9896-7ab52df8cd8a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IUIAutomation2
    {
        // IUIAutomation (55 methods)
        void _1(); void _2(); void _3(); void _4(); void _5();
        IUIAutomationElement? GetFocusedElement();
        void _7(); void _8(); void _9(); void _10(); void _11(); void _12(); void _13(); void _14(); void _15();
        void _16(); void _17(); void _18(); void _19(); void _20(); void _21(); void _22(); void _23(); void _24(); void _25();
        void _26(); void _27(); void _28(); void _29(); void _30(); void _31(); void _32(); void _33(); void _34(); void _35();
        void _36(); void _37(); void _38(); void _39(); void _40(); void _41(); void _42(); void _43(); void _44(); void _45();
        void _46(); void _47(); void _48(); void _49(); void _50(); void _51(); void _52(); void _53(); void _54(); void _55();
        // IUIAutomation2
        [return: MarshalAs(UnmanagedType.Bool)] bool get_AutoSetFocus();
        void put_AutoSetFocus([MarshalAs(UnmanagedType.Bool)] bool value);
        uint get_ConnectionTimeout();
        void put_ConnectionTimeout(uint ms);
        uint get_TransactionTimeout();
        void put_TransactionTimeout(uint ms);
    }

    [ComImport, Guid("d22108aa-8ac5-49a5-837b-37bbb3d7591e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IUIAutomationElement
    {
        void _1(); void _2(); void _3(); void _4(); void _5(); void _6(); void _7();
        [return: MarshalAs(UnmanagedType.Struct)] object? GetCurrentPropertyValue(int propertyId);
        void _9(); void _10(); void _11(); void _12(); void _13();
        [return: MarshalAs(UnmanagedType.IUnknown)] object GetCurrentPattern(int patternId);
    }

    [ComImport, Guid("32eba289-3583-42c9-9c59-3b6d9a1e9b6a"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IUIAutomationTextPattern
    {
        void _1(); void _2(); void _3(); void _4();
        IUIAutomationTextRange get_DocumentRange();
    }

    [ComImport, Guid("a543cc6a-f4ae-494b-8239-c814481187a8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IUIAutomationTextRange
    {
        void _1(); void _2(); void _3(); void _4(); void _5(); void _6();
        [return: MarshalAs(UnmanagedType.Struct)] object? GetAttributeValue(int attributeId);
        void _8(); void _9();
        [return: MarshalAs(UnmanagedType.BStr)] string? GetText(int maxLength);
    }
}
