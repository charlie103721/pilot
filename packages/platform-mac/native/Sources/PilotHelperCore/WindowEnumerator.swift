import AppKit
import CoreGraphics
import Foundation

/// The window-server-touching half of enumeration.
///
/// **Never compiled or run** (runbook amendment 8). As with
/// `PermissionProbes.swift`, everything that could be pure was moved into
/// `WindowModel.swift`, which `swift test` does cover; what is left is the
/// thinnest possible wrapper over four CoreGraphics calls.
///
/// No lifecycle logic lives here. The helper answers with a snapshot and
/// forgets — see `src/protocol/window-ops.ts` for why the diffing is on the
/// host.

public protocol WindowService {
    func snapshot(includeAllLayers: Bool) -> WindowSnapshotData
    func window(number: Int) -> (window: WindowRecord?, display: DisplayRecord?, screenLocked: Bool)
}

public final class SystemWindowService: WindowService {
    /// Bundle identifiers are stable per pid for a process's lifetime, and the
    /// Launch Services lookup is the most expensive part of enumerating a busy
    /// desktop. Cached for the helper's lifetime; a recycled pid is corrected
    /// on the next helper restart, and a wrong bundle id is cosmetic — it
    /// never feeds identity, which is `CGWindowID` plus owner pid.
    private var bundleIdentifierByPid: [Int: String] = [:]

    public init() {}

    public func snapshot(includeAllLayers: Bool) -> WindowSnapshotData {
        let displays = activeDisplays()
        var records = windowRecords(includeAllLayers: includeAllLayers)
        if records.count > maxEnumeratedWindows {
            records = Array(records.prefix(maxEnumeratedWindows))
        }
        return WindowSnapshotData(
            windows: WindowParser.assignDisplays(records, displays: displays),
            displays: displays,
            screenLocked: Self.screenIsLocked(),
            capturedAt: HelperProtocol.now()
        )
    }

    public func window(
        number: Int
    ) -> (window: WindowRecord?, display: DisplayRecord?, screenLocked: Bool) {
        let locked = Self.screenIsLocked()
        let displays = activeDisplays()
        // Resolved from the same enumeration `snapshot()` uses, then filtered
        // by `windowNumber`, so a window this helper listed is always a window
        // it can still get.
        //
        // `.optionIncludingWindow` is the obvious call here and it is wrong:
        // measured on macOS 26, it resolves a window only while that window is
        // on screen and returns an empty list for every other one. `snapshot()`
        // deliberately omits `.optionOnScreenOnly` so a user can select a
        // window that is not frontmost, so the two disagreed about almost the
        // whole desktop — 173 of 175 windows on the machine this was found on.
        //
        // Filtering by id rather than taking `.first` is load-bearing: the
        // unfiltered list is the whole desktop, and `.first` would answer with
        // an arbitrary window — a wrong answer that looks exactly like a right
        // one.
        let options: CGWindowListOption = [.excludeDesktopElements]
        guard
            let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]],
            let info = raw.first(where: { ($0[WindowInfoKey.number] as? Int) == number }),
            let parsed = WindowParser.parse(
                info, bundleIdentifier: { self.bundleIdentifier(for: $0) })
        else {
            return (nil, nil, locked)
        }
        let assigned = WindowParser.assignDisplays([parsed], displays: displays)
        guard let window = assigned.first else {
            return (nil, nil, locked)
        }
        let display = displays.first { $0.displayNumber == window.displayNumber }
        return (window, display, locked)
    }

    // MARK: - Window server

    private func windowRecords(includeAllLayers: Bool) -> [WindowRecord] {
        // Omitting `.optionOnScreenOnly` returns windows on every Space,
        // including ones currently hidden — a user may well want to select a
        // window that is not frontmost. `.excludeDesktopElements` drops the
        // wallpaper and the desktop icon layer.
        let options: CGWindowListOption = [.excludeDesktopElements]
        guard
            let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]]
        else {
            return []
        }
        var records: [WindowRecord] = []
        records.reserveCapacity(raw.count)
        for info in raw {
            guard
                let record = WindowParser.parse(
                    info, bundleIdentifier: { self.bundleIdentifier(for: $0) })
            else {
                continue
            }
            if !includeAllLayers && record.layer != 0 {
                continue
            }
            records.append(record)
        }
        return records
    }

    private func bundleIdentifier(for pid: Int) -> String? {
        if let cached = bundleIdentifierByPid[pid] {
            return cached
        }
        guard
            let application = NSRunningApplication(processIdentifier: pid_t(pid)),
            let identifier = application.bundleIdentifier
        else {
            return nil
        }
        bundleIdentifierByPid[pid] = identifier
        return identifier
    }

    // MARK: - Displays

    private func activeDisplays() -> [DisplayRecord] {
        var count: UInt32 = 0
        if CGGetActiveDisplayList(0, nil, &count) != .success || count == 0 {
            return []
        }
        var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
        if CGGetActiveDisplayList(count, &ids, &count) != .success {
            return []
        }

        var records: [DisplayRecord] = []
        records.reserveCapacity(Int(count))
        for id in ids.prefix(Int(count)) {
            let bounds = CGDisplayBounds(id)
            records.append(
                DisplayRecord(
                    displayNumber: Int(id),
                    bounds: RectRecord(
                        x: Double(bounds.origin.x),
                        y: Double(bounds.origin.y),
                        width: Double(bounds.size.width),
                        height: Double(bounds.size.height)
                    ),
                    scaleFactor: Self.scaleFactor(for: id),
                    isPrimary: CGDisplayIsMain(id) != 0
                )
            )
        }
        return records
    }

    /// Backing pixels per point, from the display mode.
    ///
    /// `CGDisplayMode.pixelWidth / CGDisplayMode.width` rather than
    /// `NSScreen.backingScaleFactor`: it is CoreGraphics only, so it does not
    /// depend on this process having an AppKit connection to the window
    /// server. Falls back to 1 rather than guessing 2.
    private static func scaleFactor(for display: CGDirectDisplayID) -> Double {
        guard let mode = CGDisplayCopyDisplayMode(display) else {
            return 1
        }
        let points = mode.width
        let pixels = mode.pixelWidth
        if points <= 0 || pixels <= 0 {
            return 1
        }
        return Double(pixels) / Double(points)
    }

    // MARK: - Session

    /// Whether the screen is locked (system-design §14: capture must stop).
    static func screenIsLocked() -> Bool {
        guard let session = CGSessionCopyCurrentDictionary() as? [String: Any] else {
            return false
        }
        if let locked = session["CGSSessionScreenIsLocked"] as? Bool {
            return locked
        }
        if let locked = session["CGSSessionScreenIsLocked"] as? NSNumber {
            return locked.intValue != 0
        }
        return false
    }
}
