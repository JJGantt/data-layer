// screenshare: the Mac half of a live screen share (src/screenAgent.ts, status-hub docs/SCREEN.md).
// The whole display, captured with ScreenCaptureKit, encoded H.264 in hardware (VideoToolbox, through
// libwebrtc's default encoder) and sent over WebRTC to the phone; Jared's taps and typing come back on a
// data channel and are posted as mouse and keyboard events here.
//
// Protocol, one JSON object per line:
//   stdin, first line   {"offer": "<sdp>", "ice": [{"urls": [...], "username": "...", "credential": "..."}]}
//   stdout              {"answer": "<sdp>"}                once ICE gathering is complete (no trickle)
//                       {"connected": true, "path": "host|srflx|prflx|relay"}
//                       {"first_frame_ms": n}              capture start to the first frame handed to WebRTC
//                       {"end": "<why>", "stats": {...}}   then it exits
//   data channel "input" (from the phone), fractions 0-1 of the display for x and y:
//     {"t":"click","x","y","button"?:"right"} {"t":"down"|"move"|"up","x","y"} {"t":"scroll","x","y","dx","dy"}
//     {"t":"text","s"} {"t":"key","k","mods"?:["cmd","shift","alt","ctrl"]} {"t":"bye"}
//   data channel (to the phone)  {"t":"display","w","h"} on open: the display's size in points
//
// It ends on its own: "bye" from the phone, the connection failing or staying disconnected 10 s, no
// connection 30 s after the answer, or stdin closing (the agent stopping it).
//
// Capturing the screen needs Screen Recording and posting events needs Accessibility; both are held by
// hands-launch, so this runs only as its descendant (the handoff agent spawns it).
import AppKit
import CoreMedia
import Foundation
import ScreenCaptureKit
import WebRTC

setvbuf(stdout, nil, _IOLBF, 0)

func emit(_ obj: [String: Any]) {
    guard let d = try? JSONSerialization.data(withJSONObject: obj), let s = String(data: d, encoding: .utf8) else { return }
    print(s)
}
func log(_ s: String) { FileHandle.standardError.write(("[screenshare] " + s + "\n").data(using: .utf8)!) }

var ended = false
var finalStats: (( @escaping ([String: Any]) -> Void) -> Void)? = nil
func end(_ why: String) {
    if ended { return }
    ended = true
    log("ending: \(why)")
    let finish = { (stats: [String: Any]) in
        emit(["end": why, "stats": stats])
        exit(0)
    }
    // The connection's own counters, read once at the end: they are cumulative, so one read gives the
    // averages over the whole share. A stats read that never answers must not keep the process alive.
    DispatchQueue.main.asyncAfter(deadline: .now() + 2) { finish([:]) }
    if let f = finalStats { f(finish) } else { finish([:]) }
}

// ---- the offer ----------------------------------------------------------------------------------
guard let line = readLine(), let data = line.data(using: .utf8),
      let start = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
      let offerSdp = start["offer"] as? String else {
    log("first line must be {\"offer\":...}")
    exit(2)
}
let iceList = start["ice"] as? [[String: Any]] ?? []

// stdin closing is the agent telling it to stop.
DispatchQueue.global().async {
    while readLine() != nil {}
    DispatchQueue.main.async { end("stopped") }
}

// ---- the display --------------------------------------------------------------------------------
let displayID = CGMainDisplayID()
let bounds = CGDisplayBounds(displayID)   // global points, top-left origin: where events go

// ---- input --------------------------------------------------------------------------------------
var lastClick: (t: TimeInterval, p: CGPoint, n: Int64) = (0, .zero, 0)
var buttonDown = false

func point(_ m: [String: Any]) -> CGPoint? {
    guard let x = (m["x"] as? NSNumber)?.doubleValue, let y = (m["y"] as? NSNumber)?.doubleValue,
          x >= 0, x <= 1, y >= 0, y <= 1 else { return nil }
    return CGPoint(x: bounds.minX + x * bounds.width, y: bounds.minY + y * bounds.height)
}

func post(_ e: CGEvent?) {
    guard let e else { return }
    e.post(tap: .cghidEventTap)
}

var warnedAccess = false
func canPost() -> Bool {
    if CGPreflightPostEventAccess() { return true }
    if !warnedAccess { warnedAccess = true; log("Accessibility is not granted to hands-launch: input is dropped") }
    return false
}

let KEYS: [String: CGKeyCode] = [
    "enter": 36, "tab": 48, "space": 49, "backspace": 51, "escape": 53, "delete": 117,
    "left": 123, "right": 124, "down": 125, "up": 126, "home": 115, "end": 119, "pageup": 116, "pagedown": 121,
]
// Letters and digits for shortcuts (cmd-c, cmd-tab): US layout virtual key codes.
let CHARKEYS: [Character: CGKeyCode] = [
    "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13,
    "e": 14, "r": 15, "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26,
    "8": 28, "0": 29, "o": 31, "u": 32, "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46,
    "`": 50, ",": 43, ".": 47, "/": 44, ";": 41, "'": 39, "[": 33, "]": 30, "\\": 42, "-": 27, "=": 24,
]

func flags(_ mods: [String]) -> CGEventFlags {
    var f: CGEventFlags = []
    for m in mods {
        switch m {
        case "cmd": f.insert(.maskCommand)
        case "shift": f.insert(.maskShift)
        case "alt": f.insert(.maskAlternate)
        case "ctrl": f.insert(.maskControl)
        default: break
        }
    }
    return f
}

func handle(_ m: [String: Any]) {
    guard let t = m["t"] as? String else { return }
    if t == "bye" { end("bye"); return }
    guard canPost() else { return }
    switch t {
    case "click":
        guard let p = point(m) else { return }
        let right = (m["button"] as? String) == "right"
        let now = ProcessInfo.processInfo.systemUptime
        // Two taps close together in time and place are a double click, as the system counts them.
        var n: Int64 = 1
        if !right, now - lastClick.t < NSEvent.doubleClickInterval, hypot(p.x - lastClick.p.x, p.y - lastClick.p.y) < 8 {
            n = lastClick.n + 1
        }
        lastClick = (now, p, n)
        let (dn, up, btn): (CGEventType, CGEventType, CGMouseButton) = right ? (.rightMouseDown, .rightMouseUp, .right) : (.leftMouseDown, .leftMouseUp, .left)
        post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
        for type in [dn, up] {
            let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: p, mouseButton: btn)
            e?.setIntegerValueField(.mouseEventClickState, value: n)
            post(e)
        }
    case "down":
        guard let p = point(m) else { return }
        buttonDown = true
        post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
        post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: p, mouseButton: .left))
    case "move":
        guard let p = point(m) else { return }
        post(CGEvent(mouseEventSource: nil, mouseType: buttonDown ? .leftMouseDragged : .mouseMoved, mouseCursorPosition: p, mouseButton: .left))
    case "up":
        guard let p = point(m) else { return }
        buttonDown = false
        post(CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: p, mouseButton: .left))
    case "scroll":
        // A scroll lands on whatever is under the pointer, so the pointer goes there first.
        if let p = point(m) { post(CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)) }
        let dx = Int32((m["dx"] as? NSNumber)?.doubleValue ?? 0), dy = Int32((m["dy"] as? NSNumber)?.doubleValue ?? 0)
        post(CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: dx, wheel3: 0))
    case "text":
        guard let s = m["s"] as? String else { return }
        let units = Array(s.utf16)
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
        guard let k = m["k"] as? String else { return }
        let code: CGKeyCode? = KEYS[k] ?? (k.count == 1 ? CHARKEYS[Character(k.lowercased())] : nil)
        guard let code else { log("unknown key \(k)"); return }
        let f = flags(m["mods"] as? [String] ?? [])
        for down in [true, false] {
            let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down)
            if !f.isEmpty { e?.flags = f }
            post(e)
        }
    default:
        log("unknown input \(t)")
    }
}

// ---- WebRTC -------------------------------------------------------------------------------------
RTCInitializeSSL()
let factory = RTCPeerConnectionFactory(encoderFactory: RTCDefaultVideoEncoderFactory(), decoderFactory: RTCDefaultVideoDecoderFactory())
let source = factory.videoSource(forScreenCast: true)
let capturer = RTCVideoCapturer(delegate: source)
let track = factory.videoTrack(with: source, trackId: "screen")

final class Peer: NSObject, RTCPeerConnectionDelegate, RTCDataChannelDelegate {
    var gathered: (() -> Void)?
    var channel: RTCDataChannel?
    var disconnectTimer: DispatchWorkItem?
    var connected = false
    weak var pc: RTCPeerConnection?

    func peerConnection(_ pc: RTCPeerConnection, didChange s: RTCSignalingState) {}
    func peerConnection(_ pc: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    func peerConnection(_ pc: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    func peerConnectionShouldNegotiate(_ pc: RTCPeerConnection) {}
    // The relay candidate is the last one worth waiting for (one round trip to the TURN server); once it
    // is in, what is still gathering (TCP relays, other interfaces) is not worth holding the answer for.
    func peerConnection(_ pc: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {
        if candidate.sdp.contains(" typ relay") {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.gathered?(); self.gathered = nil }
        }
    }
    func peerConnection(_ pc: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange s: RTCIceConnectionState) {}
    func peerConnection(_ pc: RTCPeerConnection, didChange s: RTCIceGatheringState) {
        if s == .complete { DispatchQueue.main.async { self.gathered?(); self.gathered = nil } }
    }
    func peerConnection(_ pc: RTCPeerConnection, didChange s: RTCPeerConnectionState) {
        DispatchQueue.main.async {
            switch s {
            case .connected:
                self.disconnectTimer?.cancel(); self.disconnectTimer = nil
                if !self.connected {
                    self.connected = true
                    pathOf(pc) { emit(["connected": true, "path": $0]) }
                }
            case .disconnected:
                // A blip (a wifi handover) recovers on its own; one that lasts is a phone that has gone.
                let w = DispatchWorkItem { end("disconnected") }
                self.disconnectTimer = w
                DispatchQueue.main.asyncAfter(deadline: .now() + 10, execute: w)
            case .failed: end("failed")
            case .closed: end("closed")
            default: break
            }
        }
    }
    func peerConnection(_ pc: RTCPeerConnection, didOpen dc: RTCDataChannel) {
        dc.delegate = self
        channel = dc
    }
    func dataChannelDidChangeState(_ dc: RTCDataChannel) {
        if dc.readyState == .open {
            let d = try! JSONSerialization.data(withJSONObject: ["t": "display", "w": bounds.width, "h": bounds.height])
            dc.sendData(RTCDataBuffer(data: d, isBinary: false))
        }
    }
    func dataChannel(_ dc: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        guard let m = try? JSONSerialization.jsonObject(with: buffer.data) as? [String: Any] else { return }
        DispatchQueue.main.async { handle(m) }
    }
}

/// Which way the media goes: straight across the LAN (host), through a NAT (srflx/prflx), or through
/// the TURN relay on Fly (relay).
func pathOf(_ pc: RTCPeerConnection, _ done: @escaping (String) -> Void) {
    pc.statistics { report in
        var local: String? = nil
        for (_, s) in report.statistics where s.type == "candidate-pair" {
            let v = s.values
            if (v["nominated"] as? NSNumber)?.boolValue == true, (v["state"] as? String) == "succeeded",
               let lid = v["localCandidateId"] as? String, let c = report.statistics[lid] {
                local = c.values["candidateType"] as? String
            }
        }
        DispatchQueue.main.async { done(local ?? "unknown") }
    }
}

let peer = Peer()
let config = RTCConfiguration()
config.sdpSemantics = .unifiedPlan
config.continualGatheringPolicy = .gatherOnce
config.iceServers = iceList.compactMap { s in
    let urls = (s["urls"] as? [String]) ?? ((s["urls"] as? String).map { [$0] } ?? [])
    guard !urls.isEmpty else { return nil }
    return RTCIceServer(urlStrings: urls, username: s["username"] as? String, credential: s["credential"] as? String)
}
guard let pc = factory.peerConnection(with: config, constraints: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil), delegate: peer) else {
    log("could not make a peer connection"); exit(1)
}
peer.pc = pc

finalStats = { done in
    pc.statistics { report in
        var out: [String: Any] = [:]
        for (_, s) in report.statistics {
            let v = s.values
            if s.type == "outbound-rtp", (v["kind"] as? String) == "video" {
                for k in ["bytesSent", "framesEncoded", "totalEncodeTime", "frameWidth", "frameHeight", "keyFramesEncoded",
                          "qualityLimitationReason", "encoderImplementation", "pliCount", "nackCount", "framesPerSecond"] {
                    if let x = v[k] { out[k] = x }
                }
            }
            if s.type == "candidate-pair", (v["nominated"] as? NSNumber)?.boolValue == true, (v["state"] as? String) == "succeeded" {
                for k in ["totalRoundTripTime", "responsesReceived", "currentRoundTripTime", "availableOutgoingBitrate"] {
                    if let x = v[k] { out[k] = x }
                }
                if let lid = v["localCandidateId"] as? String, let c = report.statistics[lid] { out["path"] = c.values["candidateType"] }
            }
        }
        DispatchQueue.main.async { done(out) }
    }
}

// ---- capture ------------------------------------------------------------------------------------
final class Capture: NSObject, SCStreamOutput, SCStreamDelegate {
    var stream: SCStream?
    var last: CVPixelBuffer?
    var lastAt: TimeInterval = 0
    var started: TimeInterval = 0
    var firstSent = false
    let q = DispatchQueue(label: "capture")

    func send(_ buf: CVPixelBuffer) {
        let frame = RTCVideoFrame(buffer: RTCCVPixelBuffer(pixelBuffer: buf), rotation: ._0,
                                  timeStampNs: Int64(CACurrentMediaTime() * 1_000_000_000))
        source.capturer(capturer, didCapture: frame)
        lastAt = ProcessInfo.processInfo.systemUptime
        if !firstSent {
            firstSent = true
            let ms = Int((lastAt - started) * 1000)
            DispatchQueue.main.async { emit(["first_frame_ms": ms]) }
        }
    }

    func stream(_ s: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .screen, let buf = sb.imageBuffer else { return }
        // ScreenCaptureKit hands over a frame only when the screen changed; idle and blank frames carry
        // no image.
        if let info = (CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]])?.first,
           let raw = info[.status] as? Int, let st = SCFrameStatus(rawValue: raw), st != .complete { return }
        last = buf
        send(buf)
    }

    func stream(_ s: SCStream, didStopWithError error: Error) {
        log("capture stopped: \(error.localizedDescription)")
        DispatchQueue.main.async { end("capture stopped: \(error.localizedDescription)") }
    }

    func start() async throws {
        started = ProcessInfo.processInfo.systemUptime
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == displayID }) ?? content.displays.first else {
            throw NSError(domain: "screenshare", code: 1, userInfo: [NSLocalizedDescriptionKey: "no display to capture"])
        }
        let cfg = SCStreamConfiguration()
        // Pixels, not points: the text has to survive a pinch-zoom on the phone.
        let mode = CGDisplayCopyDisplayMode(displayID)
        cfg.width = mode?.pixelWidth ?? display.width * 2
        cfg.height = mode?.pixelHeight ?? display.height * 2
        cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarFullRange
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: 30)
        cfg.showsCursor = true
        cfg.queueDepth = 6
        let s = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg, delegate: self)
        try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: q)
        try await s.startCapture()
        stream = s
        log("capturing display \(displayID) at \(cfg.width)x\(cfg.height)")
        // A still screen produces no frames, and an encoder with no new frame cannot answer the phone's
        // request for a key frame (a lost packet, a resumed app) or sharpen a picture it sent soft. So
        // the newest frame is handed over again whenever the screen has been still for a second.
        repeatIdle()
    }

    func repeatIdle() {
        q.asyncAfter(deadline: .now() + 1) { [weak self] in
            guard let self else { return }
            if let b = self.last, ProcessInfo.processInfo.systemUptime - self.lastAt >= 0.9 { self.send(b) }
            self.repeatIdle()
        }
    }
}

let capture = Capture()

// ---- the answer ---------------------------------------------------------------------------------
// Browsers offer H.264 at level 3.1, whose largest frame is 3600 macroblocks — 1280x720. A display is
// bigger than that, and libwebrtc then sends no video at all rather than a smaller one. Every phone
// that offers H.264 decodes far beyond 3.1 in hardware, and with level-asymmetry-allowed (which every
// browser sends) the level the receiver declares is what bounds the sender, so the offer's H.264 lines
// are read as level 5.2 (4096x2304).
let offerForUs = offerSdp.replacingOccurrences(of: #"profile-level-id=([0-9a-fA-F]{4})[0-9a-fA-F]{2}"#,
                                               with: "profile-level-id=$134", options: .regularExpression)
pc.setRemoteDescription(RTCSessionDescription(type: .offer, sdp: offerForUs)) { err in
    DispatchQueue.main.async {
        if let err { log("bad offer: \(err.localizedDescription)"); end("bad offer: \(err.localizedDescription)"); return }
        guard let tr = pc.transceivers.first(where: { $0.mediaType == .video }) else { end("the offer has no video"); return }
        tr.sender.track = track
        var e: NSError?
        tr.setDirection(.sendOnly, error: &e)
        // Screen text has to stay legible: under a tight link, drop frames rather than resolution.
        let params = tr.sender.parameters
        params.degradationPreference = NSNumber(value: RTCDegradationPreference.maintainResolution.rawValue)
        for enc in params.encodings { enc.maxBitrateBps = NSNumber(value: 8_000_000); enc.maxFramerate = 30 }
        tr.sender.parameters = params
        pc.answer(for: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)) { sdp, err in
            guard let sdp else { DispatchQueue.main.async { end("no answer: \(err?.localizedDescription ?? "?")") }; return }
            pc.setLocalDescription(sdp) { err in
                DispatchQueue.main.async {
                    if let err { end("local description: \(err.localizedDescription)"); return }
                    let send = {
                        guard let d = pc.localDescription else { return }
                        emit(["answer": d.sdp])
                        DispatchQueue.main.asyncAfter(deadline: .now() + 30) { if !peer.connected { end("never connected") } }
                    }
                    // Sent once a relay candidate is in (above), or gathering is complete, or after 2.5 s
                    // with whatever there is.
                    if pc.iceGatheringState == .complete { send() } else {
                        peer.gathered = send
                        DispatchQueue.main.asyncAfter(deadline: .now() + 2.5) { if let g = peer.gathered { peer.gathered = nil; g() } }
                    }
                }
            }
        }
    }
}

Task {
    do { try await capture.start() }
    catch { DispatchQueue.main.async { end("capture: \(error.localizedDescription)") } }
}

dispatchMain()
