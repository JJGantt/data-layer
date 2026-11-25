// hands: the Mac half of a handoff (src/handoffAgent.ts). Where things are on screen, and a click or
// keystrokes put there, for a tap Jared made on a screenshot from his phone or watch.
//
//   hands windows                → one line of JSON per window on screen, front to back:
//                                  {"id","app","title","x","y","w","h"} (points, any display)
//   hands window <app> [title]   → the front window of that app (exact owner name, as `windows` lists
//                                  it), the first whose title contains `title` when one is given
//   hands click <x> <y>          → a left click at that global point
//   hands type                   → types stdin as it is (any characters; nothing is echoed)
//   hands key enter|tab|backspace|escape
//
// Posting events needs Accessibility, which is held by the process that launched this (hands-launch),
// so this is run only as that launcher's descendant. Every failure exits non-zero with a reason.
import AppKit
import CoreGraphics
import Foundation

func fail(_ msg: String) -> Never {
    FileHandle.standardError.write((msg + "\n").data(using: .utf8)!)
    exit(1)
}

func json(_ obj: [String: Any]) {
    let d = try! JSONSerialization.data(withJSONObject: obj)
    print(String(data: d, encoding: .utf8)!)
}

// Without the grant macOS drops a posted event without a word, so a click would report success while
// nothing happened on screen. Checked before every post, so the handoff says why instead.
func post(_ e: CGEvent?) {
    guard CGPreflightPostEventAccess() else {
        fail("the Mac has not allowed clicks and keystrokes: turn on hands-launch under System Settings > Privacy & Security > Accessibility")
    }
    guard let e else { fail("could not make an event") }
    e.post(tap: .cghidEventTap)
}

let args = CommandLine.arguments.dropFirst()
guard let cmd = args.first else { fail("usage: hands windows|window app [title]|click x y|type|key name") }

switch cmd {
case "windows", "window":
    let want = args.dropFirst().first
    let titled = args.dropFirst(2).first
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list where (w[kCGWindowLayer as String] as? Int) == 0 {
        guard let id = w[kCGWindowNumber as String] as? Int,
              let app = w[kCGWindowOwnerName as String] as? String,
              let r = w[kCGWindowBounds as String] as? [String: CGFloat],
              let wd = r["Width"], let ht = r["Height"], wd > 40, ht > 40 else { continue }
        let title = w[kCGWindowName as String] as? String ?? ""
        let row: [String: Any] = ["id": id, "app": app, "title": title, "x": r["X"] ?? 0, "y": r["Y"] ?? 0, "w": wd, "h": ht]
        if cmd == "windows" { json(row); continue }
        if app == want && (titled == nil || title.localizedCaseInsensitiveContains(titled!)) { json(row); exit(0) }
    }
    if cmd == "window" { fail("no window of \(want ?? "?")\(titled.map { " titled \($0)" } ?? "") on screen") }

case "click":
    let v = Array(args.dropFirst())
    guard v.count == 2, let x = Double(v[0]), let y = Double(v[1]) else { fail("usage: hands click x y") }
    let p = CGPoint(x: x, y: y)
    post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left))
    post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left))

case "type":
    let text = String(data: FileHandle.standardInput.readDataToEndOfFile(), encoding: .utf8) ?? ""
    let units = Array(text.utf16)
    var i = 0
    while i < units.count {            // CGEvent carries at most 20 UTF-16 units per event
        var chunk = Array(units[i..<min(i + 20, units.count)])
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: down)
            e?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: &chunk)
            post(e)
        }
        i += 20
    }

case "key":
    let codes: [String: CGKeyCode] = ["enter": 36, "tab": 48, "backspace": 51, "escape": 53]
    guard let name = args.dropFirst().first, let code = codes[name] else { fail("usage: hands key enter|tab|backspace|escape") }
    post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true))
    post(CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false))

default:
    fail("unknown command \(cmd)")
}
