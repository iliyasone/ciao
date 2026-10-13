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
// - "field" answers "unsupported" without Accessibility. Chromium and Electron apps expose their
//   fields only to an assistive client that asks, so the first read in such an app turns that on
//   (AXManualAccessibility) and, if nothing showed yet, tries once more a moment later.
// - "activate" matches the app bundle's file name ("T3 Code (Nightly)") and answers with its pid.
// - "key" needs Accessibility too, like "paste"; without it it answers ok:false.
// - "media" pauses only Music and Spotify, through AppleScript (macOS asks the user once per app).
//   Extra command {"cmd":"media-ask"}: ask that permission now for the players that are running.
// - "key" events: "paste" is ⌘V or ⌘⇧V, by the key where QWERTY has V (so it holds in the Russian
//   layout too); Enter is Return or the keypad's Enter.

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
var watching = false
/// The app whose field Enter reads while watching (0: none).
var watchPid: pid_t = 0

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
    // A key down we pass on is the user's own: triggers, captures and an armed Esc were swallowed above.
    if watching && type == .keyDown && !swallow { reportKey(event) }
    return swallow ? nil : Unmanaged.passUnretained(event)
}

/// While watching: what kind of key the user pressed, so src/main/corrections.ts knows they are editing.
func reportKey(_ event: CGEvent) {
    if event.getIntegerValueField(.keyboardEventAutorepeat) != 0 { return }
    let code = event.getIntegerValueField(.keyboardEventKeycode)
    let flags = event.flags
    if code == 36 || code == 76 { // Return, keypad Enter
        // Read before the app gets the Enter: a chat app sends and clears the field on it. Tightly
        // bounded, as macOS disables a tap whose callback is slow.
        // Only the watched app's field: Enter anywhere else is none of Ciao's business.
        var text: String?
        if watchPid != 0, let pid = frontmost()?.processIdentifier, pid == watchPid {
            let reader = AXReader(budget: 0.15)
            _ = askForAccessibility(pid, reader)
            text = readField(pid: pid, reader).text
        }
        emit(["type": "key", "kind": "enter", "text": text])
    } else if code == 9 && flags.contains(.maskCommand) && !flags.contains(.maskControl) && !flags.contains(.maskAlternate) {
        emit(["type": "key", "kind": "paste"])
    } else {
        emit(["type": "key", "kind": "other"])
    }
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

// MARK: - Media ("media")

/// The players "media" pauses: macOS has no public way to pause any app, so it asks these apps by AppleScript.
/// The first time, macOS asks the user to let Ciao control the app; refused, that app is left playing.
let mediaApps = ["com.apple.Music", "com.spotify.client"]
/// Runs the scripts in turn, off the main run loop: a script waits for the app, and the first one for the user's answer.
let mediaQueue = DispatchQueue(label: "ciao.media")
var mediaPaused: [String] = [] // mediaQueue only

/// Runs `body` in the app with this bundle id through osascript; false if the app isn't running (a script would
/// launch it), the script fails, or it doesn't answer true.
func tellApp(_ bundle: String, _ body: [String]) -> Bool {
    guard !NSRunningApplication.runningApplications(withBundleIdentifier: bundle).isEmpty else { return false }
    let p = Process()
    p.executableURL = URL(fileURLWithPath: "/usr/bin/osascript")
    p.arguments = (["tell application id \"\(bundle)\""] + body + ["end tell"]).flatMap { ["-e", $0] }
    let out = Pipe(), err = Pipe()
    p.standardOutput = out
    p.standardError = err
    do { try p.run() } catch { return false }
    let answer = String(decoding: out.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    let problem = String(decoding: err.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    p.waitUntilExit()
    if p.terminationStatus != 0 { logLine("media: \(bundle): \(problem.trimmingCharacters(in: .whitespacesAndNewlines))") }
    return answer.trimmingCharacters(in: .whitespacesAndNewlines) == "true"
}

/// "media-ask": a harmless question to each running player, so macOS asks its permission now (in Settings, as the
/// option is turned on) rather than over the first dictation, where the text would be pasted into its alert.
func askMedia() {
    mediaQueue.async {
        for bundle in mediaApps { _ = tellApp(bundle, ["get player state"]) }
    }
}

func setMedia(pause: Bool) {
    mediaQueue.async {
        if pause {
            for bundle in mediaApps where tellApp(bundle, ["if player state is playing then", "pause", "repeat 10 times", "if player state is not playing then exit repeat", "delay 0.05", "end repeat", "return true", "end if"]) {
                mediaPaused.append(bundle)
            }
        } else {
            // Still paused: the user didn't start or stop it themselves meanwhile.
            for bundle in mediaPaused { _ = tellApp(bundle, ["if player state is paused then play"]) }
            mediaPaused = []
        }
    }
}

/// Return on its own, for "key": the flags are cleared so a modifier the user still holds doesn't make it a shortcut.
func sendEnter() {
    let source = CGEventSource(stateID: .hidSystemState)
    source?.userData = injectedMark
    for down in [true, false] {
        let e = CGEvent(keyboardEventSource: source, virtualKey: 36, keyDown: down) // Return
        e?.flags = []
        e?.post(tap: .cghidEventTap)
    }
}

/// "activate": brings a running app whose bundle file name matches to the front, through Launch Services, which
/// lets a background helper do it (a plain activate() may be refused since macOS 14). Answers with its pid, 0 if none.
func activateApp(id: Int?, pattern: String) {
    let re = try? NSRegularExpression(pattern: pattern, options: [.caseInsensitive])
    let app = NSWorkspace.shared.runningApplications.first { app in
        let name = appFile(app)
        return app.activationPolicy == .regular && re?.firstMatch(in: name, range: NSRange(name.startIndex..., in: name)) != nil
    }
    guard let app, let url = app.bundleURL else {
        emit(["id": id, "hwnd": 0])
        return
    }
    let config = NSWorkspace.OpenConfiguration()
    config.activates = true
    NSWorkspace.shared.openApplication(at: url, configuration: config) { opened, _ in
        emit(["id": id, "hwnd": opened == nil ? 0 : Int(app.processIdentifier)])
    }
}

// MARK: - Field text ("field", and Enter while watching)

/// Longer than this it is a log or a document rather than a message, and copying it costs too much.
let maxFieldLength = 100_000
let textRoles: Set<String> = ["AXTextField", "AXTextArea", "AXComboBox"]
var manualAccessibilityAsked = Set<pid_t>()
let manualAccessibilityLock = NSLock()
/// "field" reads run here, off the main run loop: that one also runs the event tap, and a read that
/// waits on a slow app there would hold up every key press on the Mac.
let axQueue = DispatchQueue(label: "ciao.ax")

struct AXTimeout: Error {}

/// Accessibility calls into another app, all sharing one deadline: each call blocks until the app
/// answers, and a hung app would otherwise hold the helper (and with it the event tap) for seconds.
struct AXReader {
    let deadline: Date

    init(budget: TimeInterval) { deadline = Date().addingTimeInterval(budget) }

    func bound(_ element: AXUIElement) throws {
        let left = deadline.timeIntervalSinceNow
        if left <= 0 { throw AXTimeout() }
        AXUIElementSetMessagingTimeout(element, Float(left))
    }

    /// The attribute's value, nil if the element has none.
    func get(_ element: AXUIElement, _ name: String) throws -> CFTypeRef? {
        try bound(element)
        var value: CFTypeRef?
        let error = AXUIElementCopyAttributeValue(element, name as CFString, &value)
        if error == .cannotComplete { throw AXTimeout() }
        return error == .success ? value : nil
    }
}

/// Chromium and Electron apps build their accessibility tree only once an assistive client asks for
/// it. (AXEnhancedUserInterface does it too, but breaks their window animations.) True when this call
/// just turned it on in such an app: its fields show up a moment later.
func askForAccessibility(_ pid: pid_t, _ reader: AXReader) -> Bool {
    manualAccessibilityLock.lock()
    let done = manualAccessibilityAsked.contains(pid)
    manualAccessibilityLock.unlock()
    guard !done else { return false }
    let app = AXUIElementCreateApplication(pid)
    guard (try? reader.bound(app)) != nil else { return false }
    let error = AXUIElementSetAttributeValue(app, "AXManualAccessibility" as CFString, kCFBooleanTrue)
    if error == .cannotComplete { return false } // the app was busy: ask again next time
    manualAccessibilityLock.lock()
    manualAccessibilityAsked.insert(pid)
    manualAccessibilityLock.unlock()
    return error == .success
}

/// The text of the focused editable field in the app `pid`, or why there is none (see "field" in Program.cs).
func readField(pid: pid_t, _ reader: AXReader) -> (text: String?, reason: String?) {
    guard AXIsProcessTrusted() else { return (nil, "unsupported") }
    do {
        // The app's own focused element: the system-wide one often comes back empty for Electron apps.
        guard let ref = try reader.get(AXUIElementCreateApplication(pid), kAXFocusedUIElementAttribute),
              CFGetTypeID(ref) == AXUIElementGetTypeID() else { return (nil, "no-field") }
        let field = ref as! AXUIElement
        let role = try reader.get(field, kAXRoleAttribute) as? String ?? ""
        let subrole = try reader.get(field, kAXSubroleAttribute) as? String ?? ""
        if role == "AXSecureTextField" || subrole == "AXSecureTextField" { return (nil, "no-field") }
        if !textRoles.contains(role) {
            // Some other element that holds text (a web page, a list): only if its text can be edited.
            try reader.bound(field)
            var settable: DarwinBoolean = false
            if AXUIElementIsAttributeSettable(field, kAXValueAttribute as CFString, &settable) == .cannotComplete { throw AXTimeout() }
            if !settable.boolValue { return (nil, "no-field") }
        }
        // The length first, so a terminal's scrollback is not copied over just to be dropped.
        if let count = try reader.get(field, kAXNumberOfCharactersAttribute) as? Int, count > maxFieldLength {
            return (nil, "too-long")
        }
        guard let text = try reader.get(field, kAXValueAttribute) as? String else { return (nil, "no-field") }
        if text.utf16.count > maxFieldLength { return (nil, "too-long") }
        return (text, nil)
    } catch {
        return (nil, "timeout")
    }
}

/// Answers "field" (called on the main thread; the read itself runs on axQueue). In a Chromium or
/// Electron app seen for the first time the tree may still be building, so an empty answer is
/// retried once a moment later.
func answerField(id: Int?, wanted: pid_t, retry: Bool) {
    let front = frontmost()?.processIdentifier
    if wanted != 0 && front != wanted {
        emit(["id": id, "text": nil, "reason": "focus-changed"])
        return
    }
    guard let pid = front else {
        emit(["id": id, "text": nil, "reason": "no-field"])
        return
    }
    axQueue.async {
        let reader = AXReader(budget: 0.5)
        let asked = AXIsProcessTrusted() && askForAccessibility(pid, reader)
        let result = readField(pid: pid, reader)
        if retry && asked && result.reason == "no-field" {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { answerField(id: id, wanted: wanted, retry: false) }
            return
        }
        if let text = result.text { emit(["id": id, "text": text]) } else { emit(["id": id, "text": nil, "reason": result.reason]) }
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
    case "field":
        answerField(id: id, wanted: (msg["hwnd"] as? NSNumber)?.int32Value ?? 0, retry: true)
    case "activate":
        activateApp(id: id, pattern: msg["process"] as? String ?? "$^")
    case "key":
        let wanted = (msg["hwnd"] as? NSNumber)?.int32Value ?? 0
        let ok = msg["key"] as? String == "enter" && AXIsProcessTrusted() && (wanted == 0 || frontmost()?.processIdentifier == wanted)
        if ok { sendEnter() }
        emit(["id": id, "ok": ok])
    case "media":
        setMedia(pause: msg["pause"] as? Bool ?? false)
    case "media-ask":
        askMedia()
    case "watch":
        watching = msg["on"] as? Bool ?? false
        watchPid = (msg["hwnd"] as? NSNumber)?.int32Value ?? 0
        // Turn a Chromium or Electron app's accessibility on now: the first Enter read has no time to wait for it.
        let pid = watchPid
        if watching && pid != 0 && AXIsProcessTrusted() { axQueue.async { _ = askForAccessibility(pid, AXReader(budget: 0.5)) } }
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
    // The parent closed the pipe: answer what is queued, resume the music it paused, flush, quit. The wait
    // for the music is here, not on the main thread, which runs the event tap.
    DispatchQueue.main.sync {}
    let media = DispatchGroup()
    mediaQueue.async(group: media) {}
    _ = media.wait(timeout: .now() + 1.5)
    DispatchQueue.main.async {
        outQueue.sync {}
        exit(0)
    }
}

emit(["type": "ready", "triggers": triggers.map(\.spec)])
waitForTap()
RunLoop.main.run()
