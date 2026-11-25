// demoreel axhelper — tiny macOS accessibility / input helper.
// Prints JSON on stdout. Requires Accessibility permission for the host app.
import AppKit
import ApplicationServices

func out(_ obj: Any) -> Never {
  let d = try! JSONSerialization.data(withJSONObject: obj, options: [])
  FileHandle.standardOutput.write(d); print(""); exit(0)
}
func fail(_ msg: String) -> Never {
  let d = try! JSONSerialization.data(withJSONObject: ["error": msg], options: [])
  FileHandle.standardOutput.write(d); print(""); exit(1)
}
func attr(_ e: AXUIElement, _ a: String) -> AnyObject? {
  var v: AnyObject?
  return AXUIElementCopyAttributeValue(e, a as CFString, &v) == .success ? v : nil
}
func children(_ e: AXUIElement) -> [AXUIElement] { attr(e, "AXChildren") as? [AXUIElement] ?? [] }
func frame(_ e: AXUIElement) -> [Int] {
  var p = CGPoint.zero, s = CGSize.zero
  if let v = attr(e, "AXPosition") { AXValueGetValue(v as! AXValue, .cgPoint, &p) }
  if let v = attr(e, "AXSize") { AXValueGetValue(v as! AXValue, .cgSize, &s) }
  return [Int(p.x), Int(p.y), Int(s.width), Int(s.height)]
}
func node(_ e: AXUIElement, _ path: String, _ depth: Int) -> [String: Any] {
  var n: [String: Any] = ["path": path, "role": attr(e, "AXRole") as? String ?? "", "frame": frame(e)]
  for (k, a) in [("subrole", "AXSubrole"), ("title", "AXTitle"), ("desc", "AXDescription"), ("id", "AXIdentifier")] {
    if let s = attr(e, a) as? String, !s.isEmpty { n[k] = s }
  }
  if let v = attr(e, "AXValue") { n["value"] = String("\(v)".prefix(200)) }
  if let en = attr(e, "AXEnabled") as? Bool, !en { n["enabled"] = false }
  if depth < 12 {
    let kids = children(e).enumerated().map { node($0.element, "\(path)/\($0.offset)", depth + 1) }
    if !kids.isEmpty { n["children"] = kids }
  }
  return n
}
func appElement(_ bid: String) -> AXUIElement {
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: bid).first else { fail("app not running: \(bid)") }
  let ax = AXUIElementCreateApplication(app.processIdentifier)
  // Do not wait the default several seconds on an app that is blocked (e.g. behind a system permission prompt).
  AXUIElementSetMessagingTimeout(ax, 1.5)
  return ax
}
/// Fails loudly when the app cannot answer at all, instead of reporting an empty interface.
func requireResponsive(_ ax: AXUIElement, _ bid: String) {
  var v: AnyObject?
  let r = AXUIElementCopyAttributeValue(ax, "AXWindows" as CFString, &v)
  if r == .cannotComplete { fail("not responding: \(bid) did not answer — it may be busy or waiting on a macOS permission prompt") }
  if r == .apiDisabled || r == .notImplemented { fail("accessibility is not available for \(bid)") }
}
func roots(_ ax: AXUIElement) -> [(String, AXUIElement)] {
  var r: [(String, AXUIElement)] = []
  for (i, w) in (attr(ax, "AXWindows") as? [AXUIElement] ?? []).enumerated() { r.append(("w\(i)", w)) }
  if let m = attr(ax, "AXExtrasMenuBar") { r.append(("x", m as! AXUIElement)) }
  return r
}
func resolve(_ ax: AXUIElement, _ path: String) -> AXUIElement? {
  let parts = path.split(separator: "/").map(String.init)
  guard let first = parts.first, var cur = roots(ax).first(where: { $0.0 == first })?.1 else { return nil }
  for p in parts.dropFirst() {
    let kids = children(cur)
    guard let i = Int(p), i < kids.count else { return nil }
    cur = kids[i]
  }
  return cur
}
func post(_ type: CGEventType, _ pt: CGPoint, _ button: CGMouseButton = .left, clicks: Int64 = 1) {
  guard let e = CGEvent(mouseEventSource: nil, mouseType: type, mouseCursorPosition: pt, mouseButton: button) else { return }
  e.setIntegerValueField(.mouseEventClickState, value: clicks)
  e.post(tap: .cghidEventTap)
}
func cursor() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }
// Smooth, eased cursor glide — reads as a human hand on video.
func glide(to: CGPoint, ms: Double, dragging: Bool = false) {
  let from = cursor()
  let steps = max(1, Int(ms / 8))
  for i in 1...steps {
    let t = Double(i) / Double(steps)
    let e = t < 0.5 ? 4 * t * t * t : 1 - pow(-2 * t + 2, 3) / 2   // easeInOutCubic
    let p = CGPoint(x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e)
    post(dragging ? .leftMouseDragged : .mouseMoved, p)
    usleep(8000)
  }
}
func flags(_ s: String) -> CGEventFlags {
  var f: CGEventFlags = []
  for m in s.lowercased().split(separator: "+") {
    switch m { case "cmd", "command": f.insert(.maskCommand); case "shift": f.insert(.maskShift)
      case "alt", "option", "opt": f.insert(.maskAlternate); case "ctrl", "control": f.insert(.maskControl); default: break }
  }
  return f
}

let args = Array(CommandLine.arguments.dropFirst())
guard let cmd = args.first else { fail("usage: axhelper <command> …") }
func num(_ i: Int) -> Double { guard i < args.count, let d = Double(args[i]) else { fail("missing/invalid numeric argument \(i)") }; return d }

switch cmd {
case "trusted":
  out(["accessibility": AXIsProcessTrusted(), "screenRecording": CGPreflightScreenCaptureAccess(), "postEvents": CGPreflightPostEventAccess()])
case "request-trust":
  let o = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
  out(["accessibility": AXIsProcessTrustedWithOptions(o)])
case "tree":
  guard args.count > 1 else { fail("tree <bundleId>") }
  let ax = appElement(args[1])
  requireResponsive(ax, args[1])
  // The menu-bar extra ("x") is listed but not expanded: its menu is large and never needed.
  out(["roots": roots(ax).map { node($0.1, $0.0, $0.0 == "x" ? 12 : 0) }])
case "press":
  guard args.count > 2 else { fail("press <bundleId> <path> [action]") }
  guard let el = resolve(appElement(args[1]), args[2]) else { fail("element not found at \(args[2])") }
  let r = AXUIElementPerformAction(el, (args.count > 3 ? args[3] : "AXPress") as CFString)
  if r != .success { fail("AX action failed: \(r.rawValue)") }
  out(["ok": true])
case "set-value":
  guard args.count > 3 else { fail("set-value <bundleId> <path> <value>") }
  guard let el = resolve(appElement(args[1]), args[2]) else { fail("element not found at \(args[2])") }
  let r = AXUIElementSetAttributeValue(el, "AXValue" as CFString, args[3] as CFString)
  if r != .success { fail("AX set failed: \(r.rawValue)") }
  AXUIElementPerformAction(el, "AXConfirm" as CFString)
  out(["ok": true])
case "windows":
  let l = CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]] ?? []
  out(["windows": l.compactMap { w -> [String: Any]? in
    guard let b = w["kCGWindowBounds"] as? [String: Any], (w["kCGWindowLayer"] as? Int ?? 0) == 0 else { return nil }
    let pid = w["kCGWindowOwnerPID"] as? Int32 ?? 0
    return ["id": w["kCGWindowNumber"] ?? 0, "app": w["kCGWindowOwnerName"] ?? "", "title": w["kCGWindowName"] ?? "",
            "bundleId": NSRunningApplication(processIdentifier: pid)?.bundleIdentifier ?? "",
            "x": b["X"] ?? 0, "y": b["Y"] ?? 0, "width": b["Width"] ?? 0, "height": b["Height"] ?? 0]
  }])
case "prompts":
  // System permission / authentication prompts currently on screen (they would show up in a capture).
  let owners: Set<String> = ["UserNotificationCenter", "CoreServicesUIAgent", "universalAccessAuthWarn", "SecurityAgent", "coreautha"]
  let l = CGWindowListCopyWindowInfo([.optionOnScreenOnly], kCGNullWindowID) as? [[String: Any]] ?? []
  out(["prompts": l.compactMap { w -> [String: Any]? in
    guard let o = w["kCGWindowOwnerName"] as? String, owners.contains(o), let b = w["kCGWindowBounds"] as? [String: Any] else { return nil }
    return ["owner": o, "x": b["X"] ?? 0, "y": b["Y"] ?? 0, "width": b["Width"] ?? 0, "height": b["Height"] ?? 0]
  }])
case "displays":
  let primaryH = NSScreen.screens.first?.frame.height ?? 0
  out(["displays": NSScreen.screens.enumerated().map { (i, s) -> [String: Any] in
    // x/y are top-left-origin global coordinates (same space as window bounds and mouse events)
    ["index": i + 1, "x": Int(s.frame.minX), "y": Int(primaryH - s.frame.maxY), "width": Int(s.frame.width), "height": Int(s.frame.height),
     "scale": s.backingScaleFactor, "menuBarHeight": Int(s.frame.maxY - s.visibleFrame.maxY)]
  }])
case "set-window":
  // set-window <bundleId> <x> <y> <w> <h> [titleSubstring]
  guard args.count > 5 else { fail("set-window <bundleId> <x> <y> <w> <h> [title]") }
  let ax = appElement(args[1])
  let wins = attr(ax, "AXWindows") as? [AXUIElement] ?? []
  let want = args.count > 6 ? args[6].lowercased() : ""
  guard let w = wins.first(where: { want.isEmpty || ((attr($0, "AXTitle") as? String) ?? "").lowercased().contains(want) }) else { fail("no matching window") }
  var p = CGPoint(x: num(2), y: num(3)), s = CGSize(width: num(4), height: num(5))
  AXUIElementSetAttributeValue(w, "AXPosition" as CFString, AXValueCreate(.cgPoint, &p)!)
  AXUIElementSetAttributeValue(w, "AXSize" as CFString, AXValueCreate(.cgSize, &s)!)
  AXUIElementSetAttributeValue(w, "AXPosition" as CFString, AXValueCreate(.cgPoint, &p)!)
  AXUIElementPerformAction(w, "AXRaise" as CFString)
  NSRunningApplication.runningApplications(withBundleIdentifier: args[1]).first?.activate()
  usleep(250_000)
  out(["ok": true, "title": attr(w, "AXTitle") as? String ?? "", "frame": frame(w)])
case "activate":
  guard args.count > 1 else { fail("activate <bundleId>") }
  guard let app = NSRunningApplication.runningApplications(withBundleIdentifier: args[1]).first else { fail("app not running: \(args[1])") }
  app.activate(options: [.activateAllWindows])
  usleep(350_000)
  out(["ok": true, "active": app.isActive])
case "cursor":
  let c = cursor(); out(["x": Int(c.x), "y": Int(c.y)])
case "move":
  // move <x> <y> [ms]
  glide(to: CGPoint(x: num(1), y: num(2)), ms: args.count > 3 ? num(3) : 600)
  out(["ok": true])
case "click":
  // click <x> <y> [ms] [left|right] [count]
  let pt = CGPoint(x: num(1), y: num(2))
  glide(to: pt, ms: args.count > 3 ? num(3) : 600)
  let right = args.count > 4 && args[4] == "right"
  let n = args.count > 5 ? Int(num(5)) : 1
  usleep(120_000)
  for i in 1...max(1, n) {
    post(right ? .rightMouseDown : .leftMouseDown, pt, right ? .right : .left, clicks: Int64(i)); usleep(70_000)
    post(right ? .rightMouseUp : .leftMouseUp, pt, right ? .right : .left, clicks: Int64(i)); usleep(90_000)
  }
  out(["ok": true])
case "drag":
  // drag <x1> <y1> <x2> <y2> [ms]
  let a = CGPoint(x: num(1), y: num(2)), b = CGPoint(x: num(3), y: num(4))
  glide(to: a, ms: 400); usleep(100_000)
  post(.leftMouseDown, a); usleep(100_000)
  glide(to: b, ms: args.count > 5 ? num(5) : 700, dragging: true); usleep(100_000)
  post(.leftMouseUp, b)
  out(["ok": true])
case "scroll":
  // scroll <dy> [dx] — in lines, sent in small steps so it looks smooth on video
  let dy = Int(num(1)), dx = args.count > 2 ? Int(num(2)) : 0
  let steps = max(abs(dy), abs(dx), 1)
  for _ in 0..<steps {
    CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(dy.signum()), wheel2: Int32(dx.signum()), wheel3: 0)?.post(tap: .cghidEventTap)
    usleep(30_000)
  }
  out(["ok": true])
case "type":
  // type <text> [msPerChar]
  guard args.count > 1 else { fail("type <text> [msPerChar]") }
  let delay = useconds_t((args.count > 2 ? num(2) : 45) * 1000)
  for ch in args[1] {
    let u = Array(String(ch).utf16)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: nil, virtualKey: ch == "\n" ? 36 : 0, keyDown: down)
      if ch != "\n" { e?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: u) }
      e?.post(tap: .cghidEventTap)
    }
    usleep(delay)
  }
  out(["ok": true])
case "key":
  // key <virtualKeyCode> [mods e.g. cmd+shift]
  let f = args.count > 2 ? flags(args[2]) : []
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(num(1)), keyDown: down)
    e?.flags = f; e?.post(tap: .cghidEventTap); usleep(40_000)
  }
  out(["ok": true])
default:
  fail("unknown command: \(cmd)")
}
