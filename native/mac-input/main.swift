// macOS input bridge for the Electron app: the same JSON-lines protocol over stdin/stdout as
// native/win-input (see Program.cs there for the full list of events and commands), so
// src/main/input.ts drives both. Triggers use the Windows syntax too ("RMenu", "Ctrl+Space",
// "MButton"), with macOS keys mapped onto Windows names: Option is Alt ("LMenu"/"RMenu"),
// Command is Win ("LWin"/"RWin"); Fn is "Fn". So settings and the UI don't care which OS wrote them.
//
// Differences from Windows:
// - "hwnd" is the process id of the frontmost app: macOS gives no window handles to other apps.
// - "process" is the app bundle's file name ("Visual Studio Code", "iTerm"): unlike the shown name
//   it is not localized. "title" is the shown name: window titles need Screen Recording permission.
// - "paste" answers {"ok":false,"reason":"no-permission"} without Accessibility: macOS would
//   drop the ⌘V silently.
// - The event tap needs the Accessibility permission. Until it is granted the helper reports
//   {"type":"permission","accessibility":false} and retries every 2 s; then it reports true.

import AppKit
import ApplicationServices
import Foundation

// MARK: - Output

let outQueue = DispatchQueue(label: "ciao.out")

func emit(_ fields: [String: Any?]) {
    let clean = fields.mapValues { $0 ?? NSNull() }
    guard let data = try? JSONSerialization.data(withJSONObject: clean, options: [.withoutEscapingSlashes]) else { return }
    outQueue.async {
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data([0x0A]))
    }
}

func logLine(_ message: String) {
    emit(["type": "log", "message": message])
}

// MARK: - Keys

/// Modifier keys: their name and the device-dependent flag bit that says whether this exact key is down.
let modifierKeys: [Int64: (name: String, mask: UInt64)] = [
    59: ("LControlKey", 0x0000_0001), 62: ("RControlKey", 0x0000_2000),
    56: ("LShiftKey", 0x0000_0002), 60: ("RShiftKey", 0x0000_0004),
    58: ("LMenu", 0x0000_0020), 61: ("RMenu", 0x0000_0040),
    55: ("LWin", 0x0000_0008), 54: ("RWin", 0x0000_0010),
    63: ("Fn", CGEventFlags.maskSecondaryFn.rawValue),
]

/// macOS virtual key codes under their System.Windows.Forms.Keys names.
let keyNames: [Int64: String] = {
    var m: [Int64: String] = [
        0: "A", 11: "B", 8: "C", 2: "D", 14: "E", 3: "F", 5: "G", 4: "H", 34: "I", 38: "J", 40: "K", 37: "L", 46: "M",
        45: "N", 31: "O", 35: "P", 12: "Q", 15: "R", 1: "S", 17: "T", 32: "U", 9: "V", 13: "W", 7: "X", 16: "Y", 6: "Z",
        29: "D0", 18: "D1", 19: "D2", 20: "D3", 21: "D4", 23: "D5", 22: "D6", 26: "D7", 28: "D8", 25: "D9",
        24: "Oemplus", 27: "OemMinus", 33: "OemOpenBrackets", 30: "Oem6", 42: "Oem5", 41: "Oem1", 39: "Oem7",
        43: "Oemcomma", 47: "OemPeriod", 44: "OemQuestion", 50: "Oemtilde", 10: "Oem102",
        36: "Return", 76: "Return", 48: "Tab", 49: "Space", 51: "Back", 117: "Delete", 53: "Escape",
        115: "Home", 119: "End", 116: "PageUp", 121: "PageDown", 114: "Help",
        123: "Left", 124: "Right", 125: "Down", 126: "Up",
        82: "NumPad0", 83: "NumPad1", 84: "NumPad2", 85: "NumPad3", 86: "NumPad4", 87: "NumPad5", 88: "NumPad6",
        89: "NumPad7", 91: "NumPad8", 92: "NumPad9", 65: "Decimal", 67: "Multiply", 69: "Add", 75: "Divide",
        78: "Subtract", 71: "Clear",
        122: "F1", 120: "F2", 99: "F3", 118: "F4", 96: "F5", 97: "F6", 98: "F7", 100: "F8", 101: "F9", 109: "F10",
        103: "F11", 111: "F12", 105: "F13", 107: "F14", 113: "F15", 106: "F16", 64: "F17", 79: "F18", 80: "F19", 90: "F20",
    ]
    for (code, name) in modifierKeys { m[code] = name.name }
    return m
}()

/// Windows names that mean "either side", accepted in triggers written by hand.
let genericModifiers: [String: [String]] = [
    "controlkey": ["LControlKey", "RControlKey"], "shiftkey": ["LShiftKey", "RShiftKey"], "menu": ["LMenu", "RMenu"],
]

let mouseButtons = ["MButton", "XButton1", "XButton2"]

struct Modifiers: Equatable {
    var ctrl = false, alt = false, shift = false, win = false

    init(ctrl: Bool = false, alt: Bool = false, shift: Bool = false, win: Bool = false) {
        self.ctrl = ctrl; self.alt = alt; self.shift = shift; self.win = win
    }

    init(_ flags: CGEventFlags) {
        self.init(ctrl: flags.contains(.maskControl), alt: flags.contains(.maskAlternate),
                  shift: flags.contains(.maskShift), win: flags.contains(.maskCommand))
    }

    init(names: Set<String>) {
        self.init(ctrl: names.contains("LControlKey") || names.contains("RControlKey"),
                  alt: names.contains("LMenu") || names.contains("RMenu"),
                  shift: names.contains("LShiftKey") || names.contains("RShiftKey"),
                  win: names.contains("LWin") || names.contains("RWin"))
    }

    var prefix: String { (ctrl ? "Ctrl+" : "") + (alt ? "Alt+" : "") + (shift ? "Shift+" : "") + (win ? "Win+" : "") }
}

/// A dictation trigger: optional modifiers, then one key or mouse button (see Triggers.cs).
final class Trigger {
    let spec: String
    let keys: Set<String> // a key name ("RMenu", "Space"), or both sides for a generic modifier
    let mouse: String?
    let mods: Modifiers
    var active = false

    init(spec: String, keys: Set<String>, mouse: String?, mods: Modifiers) {
        self.spec = spec; self.keys = keys; self.mouse = mouse; self.mods = mods
    }

    /// A bare modifier like Right Option: never swallowed, so Option shortcuts keep working.
    var isLoneModifier: Bool { mouse == nil && keys.allSatisfy(isModifier) && mods == Modifiers() }

    func modifiersMatch(_ now: Modifiers) -> Bool { isLoneModifier || now == mods }

    static func parse(_ spec: String) -> Trigger? {
        let parts = spec.split(separator: "+").map { $0.trimmingCharacters(in: .whitespaces) }.filter { !$0.isEmpty }
        guard let last = parts.last else { return nil }
        var mods = Modifiers()
        for m in parts.dropLast() {
            switch m.lowercased() {
            case "ctrl": mods.ctrl = true
            case "alt": mods.alt = true
            case "shift": mods.shift = true
            case "win": mods.win = true
            default: return nil
            }
        }
        if let button = mouseButtons.first(where: { $0.caseInsensitiveCompare(last) == .orderedSame }) {
            return Trigger(spec: spec, keys: [], mouse: button, mods: mods)
        }
        if let both = genericModifiers[last.lowercased()] {
            return Trigger(spec: spec, keys: Set(both), mouse: nil, mods: mods)
        }
        guard let name = Set(keyNames.values).first(where: { $0.caseInsensitiveCompare(last) == .orderedSame }) else { return nil }
        return Trigger(spec: spec, keys: [name], mouse: nil, mods: mods)
    }
}

func isModifier(_ name: String) -> Bool { modifierKeys.values.contains { $0.name == name } }

// MARK: - State (main thread only: the tap and the commands both run on the main run loop)

var triggers: [Trigger] = []
var armed = false
var capturing = false
var captureMods = Set<String>()
var loneModifier: String?
var swallowKeyUp: String?
var swallowMouseUp: String?

func setTriggers(_ specs: [String]) {
    triggers = specs.compactMap { spec in
        if let t = Trigger.parse(spec) { return t }
        logLine("bad trigger: \(spec)")
        return nil
    }
}

// MARK: - Event handling

/// Returns true to swallow the event.
func onKey(_ key: String, down: Bool, mods: Modifiers) -> Bool {
    if capturing { return captureKey(key, down: down) }
    if !down && swallowKeyUp == key {
        swallowKeyUp = nil
        return true
    }

    var swallow = false
    for t in triggers where t.mouse == nil && t.keys.contains(key) {
        if down {
            if !t.active && t.modifiersMatch(mods) {
                t.active = true
                emit(["type": "trigger", "down": true, "spec": t.spec])
            }
            if t.active && !t.isLoneModifier { swallow = true } // also eats auto-repeat
        } else if t.active {
            t.active = false
            emit(["type": "trigger", "down": false, "spec": t.spec])
            if !t.isLoneModifier { swallow = true }
        }
    }
    if swallow || !down { return swallow }

    if armed && key == "Escape" {
        emit(["type": "escape"])
        return true
    }
    if triggers.contains(where: { $0.active && $0.isLoneModifier && !$0.keys.contains(key) }) { emit(["type": "other"]) }
    return false
}

func onMouse(_ button: String, down: Bool, mods: Modifiers) -> Bool {
    if capturing {
        if down {
            endCapture(Modifiers(names: captureMods).prefix + button)
            swallowMouseUp = button
        }
        return true
    }
    if !down && swallowMouseUp == button {
        swallowMouseUp = nil
        return true
    }

    var swallow = false
    for t in triggers where t.mouse == button {
        if down && !t.active && t.modifiersMatch(mods) {
            t.active = true
            emit(["type": "trigger", "down": true, "spec": t.spec])
            swallow = true
        } else if !down && t.active {
            t.active = false
            emit(["type": "trigger", "down": false, "spec": t.spec])
            swallow = true
        }
    }
    return swallow
}

/// As on Windows: a modifier pressed and released alone becomes a lone-modifier trigger; otherwise
/// the first other key or mouse button, with the modifiers held, is the trigger. Esc alone cancels.
func captureKey(_ key: String, down: Bool) -> Bool {
    if isModifier(key) {
        if down {
            captureMods.insert(key)
            if loneModifier == nil { loneModifier = key }
        } else {
            captureMods.remove(key)
            if loneModifier == key { endCapture(key) }
        }
        return true
    }
    if !down { return true }
    if key == "Escape" && captureMods.isEmpty {
        endCapture(nil)
        return true
    }
    endCapture(Modifiers(names: captureMods).prefix + key)
    swallowKeyUp = key
    return true
}

func startCapture() {
    captureMods.removeAll()
    loneModifier = nil
    capturing = true
}

func endCapture(_ spec: String?) {
    capturing = false
    captureMods.removeAll()
    loneModifier = nil
    emit(["type": "captured", "spec": spec])
}

// MARK: - Event tap

/// Marks the events we post ourselves (⌘V), so the tap lets them through untouched.
let injectedMark: Int64 = 0x4349_414F // "CIAO"
var tap: CFMachPort?
var acceptInjected = false

let tapCallback: CGEventTapCallBack = { _, type, event, _ in
    if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
        if let tap { CGEvent.tapEnable(tap: tap, enable: true) }
        return Unmanaged.passUnretained(event)
    }
    if !acceptInjected && event.getIntegerValueField(.eventSourceUserData) == injectedMark {
        return Unmanaged.passUnretained(event)
    }
    let mods = Modifiers(event.flags)
    var swallow = false
    switch type {
    case .keyDown, .keyUp:
        if let key = keyNames[event.getIntegerValueField(.keyboardEventKeycode)] {
            swallow = onKey(key, down: type == .keyDown, mods: mods)
        }
    case .flagsChanged:
        let code = event.getIntegerValueField(.keyboardEventKeycode)
        if let m = modifierKeys[code] {
            let down = event.flags.rawValue & m.mask != 0
            swallow = onKey(m.name, down: down, mods: mods)
        }
    case .otherMouseDown, .otherMouseUp:
        let n = event.getIntegerValueField(.mouseEventButtonNumber)
        if (2...4).contains(n) {
            swallow = onMouse(mouseButtons[Int(n) - 2], down: type == .otherMouseDown, mods: mods)
        }
    default:
        break
    }
    return swallow ? nil : Unmanaged.passUnretained(event)
}

func installTap() -> Bool {
    let types: [CGEventType] = [.keyDown, .keyUp, .flagsChanged, .otherMouseDown, .otherMouseUp]
    let mask = types.reduce(CGEventMask(0)) { $0 | (CGEventMask(1) << CGEventMask($1.rawValue)) }
    guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap, options: .defaultTap,
                                       eventsOfInterest: mask, callback: tapCallback, userInfo: nil) else { return false }
    tap = port
    let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
    CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes)
    CGEvent.tapEnable(tap: port, enable: true)
    return true
}

/// Creates the tap once the Accessibility permission is there (the app asks for it, see src/main/main.ts).
func waitForTap() {
    if installTap() {
        emit(["type": "permission", "accessibility": true])
        return
    }
    emit(["type": "permission", "accessibility": false])
    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { timer in
        guard AXIsProcessTrusted(), installTap() else { return }
        timer.invalidate()
        emit(["type": "permission", "accessibility": true])
    }
}

// MARK: - Commands

func frontmost() -> NSRunningApplication? { NSWorkspace.shared.frontmostApplication }

func appName(_ app: NSRunningApplication?) -> String {
    app?.localizedName ?? app?.bundleURL?.deletingPathExtension().lastPathComponent ?? ""
}

/// The bundle's file name without ".app": the same in every system language, unlike localizedName.
func appFile(_ app: NSRunningApplication?) -> String {
    app?.bundleURL?.deletingPathExtension().lastPathComponent ?? app?.localizedName ?? ""
}

/// ⌘V. The flags are set explicitly, so a modifier the user still holds (Option+Shift from the
/// paste-last hotkey) doesn't turn it into another shortcut.
func sendPaste() {
    let source = CGEventSource(stateID: .hidSystemState)
    source?.userData = injectedMark
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: 9, keyDown: down) // the V key
        e?.flags = .maskCommand
        e?.post(tap: .cghidEventTap)
    }
}

func handle(_ line: String) {
    guard let data = line.data(using: .utf8),
          let msg = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
    let id = msg["id"] as? Int
    switch msg["cmd"] as? String {
    case "foreground":
        let app = frontmost()
        emit(["id": id, "hwnd": Int(app?.processIdentifier ?? 0), "title": appName(app), "process": appFile(app)])
    case "paste":
        let wanted = (msg["hwnd"] as? NSNumber)?.int32Value ?? 0
        let front = frontmost()
        if wanted != 0 && front?.processIdentifier != wanted {
            let target = NSRunningApplication(processIdentifier: wanted)
            emit([
                "id": id, "ok": false, "reason": "focus-changed", "foreground": appName(front), "foregroundProcess": appFile(front),
                "targetExists": target != nil && target?.isTerminated == false,
            ])
            return
        }
        if !AXIsProcessTrusted() {
            emit(["id": id, "ok": false, "reason": "no-permission"])
            return
        }
        sendPaste()
        emit(["id": id, "ok": true])
    case "arm":
        armed = msg["on"] as? Bool ?? false
    case "triggers":
        setTriggers(msg["list"] as? [String] ?? [])
    case "capture":
        if msg["on"] as? Bool ?? false { startCapture() } else { capturing = false }
    default:
        break
    }
}

// MARK: - Main

let args = CommandLine.arguments
var specs: [String] = []
for i in args.indices.dropLast() where args[i] == "--trigger" { specs.append(args[i + 1]) }
setTriggers(specs)
acceptInjected = args.contains("--accept-injected")

Thread.detachNewThread {
    while let line = readLine() {
        DispatchQueue.main.async { handle(line) }
    }
    // The parent closed the pipe: answer what is queued, flush, quit.
    DispatchQueue.main.async {
        outQueue.sync {}
        exit(0)
    }
}

emit(["type": "ready", "triggers": triggers.map(\.spec)])
waitForTap()
RunLoop.main.run()
