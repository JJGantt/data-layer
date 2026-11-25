// hands: the Mac half of a handoff (src/handoffAgent.ts). Where things are on screen, and a click or
// keystrokes put there, for a tap Jared made on a screenshot from his phone or watch.
//
//   hands screen                 → {"x","y","w","h"} of the main display, in points
//   hands chrome                 → {"id","x","y","w","h"} of Chrome's frontmost window, in points
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

func post(_ e: CGEvent?) {
    guard let e else { fail("could not make an event") }
    e.post(tap: .cghidEventTap)
}

let args = CommandLine.arguments.dropFirst()
guard let cmd = args.first else { fail("usage: hands screen|chrome|click x y|type|key name") }

switch cmd {
case "screen":
    let b = CGDisplayBounds(CGMainDisplayID())
    json(["x": b.origin.x, "y": b.origin.y, "w": b.width, "h": b.height])

case "chrome":
    let list = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
    for w in list where (w[kCGWindowOwnerName as String] as? String) == "Google Chrome"
        && (w[kCGWindowLayer as String] as? Int) == 0 {
        guard let id = w[kCGWindowNumber as String] as? Int,
              let r = w[kCGWindowBounds as String] as? [String: CGFloat],
              let wd = r["Width"], let ht = r["Height"], wd > 200, ht > 200 else { continue }
        json(["id": id, "x": r["X"] ?? 0, "y": r["Y"] ?? 0, "w": wd, "h": ht])
        exit(0)
    }
    fail("no Chrome window on screen")

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
