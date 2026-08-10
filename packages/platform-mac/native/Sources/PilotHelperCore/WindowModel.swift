import Foundation

/// Window and display records, and the **pure** parsing that produces them.
///
/// `CGWindowListCopyWindowInfo` hands back an array of dictionaries. Parsing
/// those dictionaries is separated from fetching them so `swift test` can feed
/// synthetic dictionaries through the exact code path the real window server
/// drives — no window server, no permissions, no display required.
///
/// Mirrors `packages/platform-mac/src/protocol/window-ops.ts`.

public struct RectRecord: Equatable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    public var centerX: Double { x + width / 2 }
    public var centerY: Double { y + height / 2 }

    public func contains(x pointX: Double, y pointY: Double) -> Bool {
        pointX >= x && pointX < x + width && pointY >= y && pointY < y + height
    }

    public var jsonObject: [String: Any] {
        ["x": x, "y": y, "width": width, "height": height]
    }

    /// Parses `kCGWindowBounds`, whose keys are `X`, `Y`, `Width`, `Height`.
    public static func fromWindowBounds(_ value: Any?) -> RectRecord? {
        guard let dictionary = value as? [String: Any] else {
            return nil
        }
        guard
            let x = numeric(dictionary["X"]),
            let y = numeric(dictionary["Y"]),
            let width = numeric(dictionary["Width"]),
            let height = numeric(dictionary["Height"])
        else {
            return nil
        }
        return RectRecord(x: x, y: y, width: width, height: height)
    }

    /// Core Foundation hands numbers back as `NSNumber`; the concrete Swift
    /// type they bridge to varies, so accept anything numeric.
    static func numeric(_ value: Any?) -> Double? {
        if let number = value as? NSNumber {
            return number.doubleValue
        }
        if let double = value as? Double {
            return double
        }
        if let int = value as? Int {
            return Double(int)
        }
        return nil
    }
}

public struct DisplayRecord {
    public let displayNumber: Int
    public let bounds: RectRecord
    public let scaleFactor: Double
    public let isPrimary: Bool

    public init(displayNumber: Int, bounds: RectRecord, scaleFactor: Double, isPrimary: Bool) {
        self.displayNumber = displayNumber
        self.bounds = bounds
        self.scaleFactor = scaleFactor
        self.isPrimary = isPrimary
    }

    public var jsonObject: [String: Any] {
        [
            "displayNumber": displayNumber,
            "bounds": bounds.jsonObject,
            "scaleFactor": scaleFactor,
            "isPrimary": isPrimary,
        ]
    }
}

public struct WindowRecord {
    public let windowNumber: Int
    public let ownerPid: Int
    public let applicationName: String
    public let applicationBundleId: String?
    public let title: String?
    public let titleAvailable: Bool
    public let bounds: RectRecord
    public let displayNumber: Int?
    public let isOnScreen: Bool
    public let layer: Int

    public init(
        windowNumber: Int,
        ownerPid: Int,
        applicationName: String,
        applicationBundleId: String?,
        title: String?,
        titleAvailable: Bool,
        bounds: RectRecord,
        displayNumber: Int?,
        isOnScreen: Bool,
        layer: Int
    ) {
        self.windowNumber = windowNumber
        self.ownerPid = ownerPid
        self.applicationName = applicationName
        self.applicationBundleId = applicationBundleId
        self.title = title
        self.titleAvailable = titleAvailable
        self.bounds = bounds
        self.displayNumber = displayNumber
        self.isOnScreen = isOnScreen
        self.layer = layer
    }

    public var jsonObject: [String: Any] {
        [
            "windowNumber": windowNumber,
            "ownerPid": ownerPid,
            "applicationName": applicationName,
            "applicationBundleId": JSONValue.orNull(applicationBundleId),
            "title": JSONValue.orNull(title),
            "titleAvailable": titleAvailable,
            "bounds": bounds.jsonObject,
            "displayNumber": JSONValue.orNull(displayNumber),
            "isOnScreen": isOnScreen,
            "layer": layer,
        ]
    }
}

/// Keys of the `CGWindowListCopyWindowInfo` dictionaries, as literals.
///
/// Literals rather than the CoreGraphics constants so this file imports
/// nothing but Foundation and stays testable off a Mac. The values are fixed
/// by the API and have not changed since the call was introduced.
public enum WindowInfoKey {
    public static let number = "kCGWindowNumber"
    public static let ownerPID = "kCGWindowOwnerPID"
    public static let ownerName = "kCGWindowOwnerName"
    public static let name = "kCGWindowName"
    public static let bounds = "kCGWindowBounds"
    public static let isOnscreen = "kCGWindowIsOnscreen"
    public static let layer = "kCGWindowLayer"
    public static let alpha = "kCGWindowAlpha"
}

public enum WindowParser {
    /// Parses one window-server dictionary.
    ///
    /// `bundleIdentifier` is injected rather than looked up here so the parser
    /// stays pure; the live enumerator supplies a Launch Services lookup and
    /// the tests supply a table.
    ///
    /// Returns `nil` only when the dictionary lacks an id, an owner or usable
    /// bounds — a record that cannot be identified is not one to guess at.
    public static func parse(
        _ info: [String: Any],
        bundleIdentifier: (Int) -> String?
    ) -> WindowRecord? {
        guard
            let number = RectRecord.numeric(info[WindowInfoKey.number]).map({ Int($0) }),
            let ownerPid = RectRecord.numeric(info[WindowInfoKey.ownerPID]).map({ Int($0) }),
            let bounds = RectRecord.fromWindowBounds(info[WindowInfoKey.bounds])
        else {
            return nil
        }

        // The distinction that matters: macOS omits `kCGWindowName` entirely
        // when Screen Recording is not in force, which is not the same as a
        // window whose title is the empty string.
        let hasTitleKey = info[WindowInfoKey.name] != nil
        let title = info[WindowInfoKey.name] as? String

        return WindowRecord(
            windowNumber: number,
            ownerPid: ownerPid,
            applicationName: (info[WindowInfoKey.ownerName] as? String) ?? "",
            applicationBundleId: bundleIdentifier(ownerPid),
            title: title,
            titleAvailable: hasTitleKey,
            bounds: bounds,
            displayNumber: nil,
            isOnScreen: (info[WindowInfoKey.isOnscreen] as? Bool) ?? false,
            layer: RectRecord.numeric(info[WindowInfoKey.layer]).map({ Int($0) }) ?? 0
        )
    }

    /// The display holding a window's centre, else the primary, else none.
    ///
    /// Centre rather than origin: a window straddling two displays belongs to
    /// the one showing most of it, and its origin may sit on the other.
    public static func displayNumber(
        for bounds: RectRecord,
        displays: [DisplayRecord]
    ) -> Int? {
        for display in displays {
            if display.bounds.contains(x: bounds.centerX, y: bounds.centerY) {
                return display.displayNumber
            }
        }
        for display in displays {
            if display.isPrimary {
                return display.displayNumber
            }
        }
        return displays.first?.displayNumber
    }

    /// Assigns each window the display it sits on.
    public static func assignDisplays(
        _ windows: [WindowRecord],
        displays: [DisplayRecord]
    ) -> [WindowRecord] {
        windows.map { window in
            WindowRecord(
                windowNumber: window.windowNumber,
                ownerPid: window.ownerPid,
                applicationName: window.applicationName,
                applicationBundleId: window.applicationBundleId,
                title: window.title,
                titleAvailable: window.titleAvailable,
                bounds: window.bounds,
                displayNumber: displayNumber(for: window.bounds, displays: displays),
                isOnScreen: window.isOnScreen,
                layer: window.layer
            )
        }
    }

    /// True when macOS withheld the title of every window it returned.
    ///
    /// An independent cross-check on the Screen Recording probe: this is what
    /// an ungranted (or misattributed) capture permission looks like from the
    /// window list, whatever TCC reports. Vacuously false for an empty list —
    /// a machine with no windows is not evidence of anything.
    public static func titlesWithheld(_ windows: [WindowRecord]) -> Bool {
        if windows.isEmpty {
            return false
        }
        for window in windows {
            if window.titleAvailable {
                return false
            }
        }
        return true
    }
}

public struct WindowSnapshotData {
    public let windows: [WindowRecord]
    public let displays: [DisplayRecord]
    public let screenLocked: Bool
    public let capturedAt: Int

    public init(
        windows: [WindowRecord],
        displays: [DisplayRecord],
        screenLocked: Bool,
        capturedAt: Int
    ) {
        self.windows = windows
        self.displays = displays
        self.screenLocked = screenLocked
        self.capturedAt = capturedAt
    }

    public var jsonObject: [String: Any] {
        [
            "windows": windows.map { $0.jsonObject },
            "displays": displays.map { $0.jsonObject },
            "screenLocked": screenLocked,
            "titlesWithheld": WindowParser.titlesWithheld(windows),
            "capturedAt": capturedAt,
        ]
    }
}

/// Upper bound on one snapshot. Matches `MAX_ENUMERATED_WINDOWS` on the host,
/// which rejects anything longer — the helper truncates so a desktop with an
/// absurd number of surfaces degrades rather than failing the schema.
public let maxEnumeratedWindows = 512
