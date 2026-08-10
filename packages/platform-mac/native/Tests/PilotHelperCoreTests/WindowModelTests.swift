import Foundation
import XCTest

@testable import PilotHelperCore

/// Covers the window-server dictionary parser and the display assignment.
///
/// The dictionaries below are the shape `CGWindowListCopyWindowInfo` returns,
/// so the parser is exercised on exactly the input the real call produces —
/// without a window server, a display or a Screen Recording grant.
final class WindowModelTests: XCTestCase {
    private func windowInfo(
        number: Int = 42,
        ownerPid: Int = 501,
        ownerName: String = "Safari",
        name: String? = "Billing Settings",
        includeName: Bool = true,
        bounds: [String: Any] = ["X": 100, "Y": 80, "Width": 1200, "Height": 800],
        onscreen: Bool = true,
        layer: Int = 0
    ) -> [String: Any] {
        var info: [String: Any] = [
            WindowInfoKey.number: NSNumber(value: number),
            WindowInfoKey.ownerPID: NSNumber(value: ownerPid),
            WindowInfoKey.ownerName: ownerName,
            WindowInfoKey.bounds: bounds,
            WindowInfoKey.isOnscreen: onscreen,
            WindowInfoKey.layer: NSNumber(value: layer),
        ]
        if includeName, let title = name {
            info[WindowInfoKey.name] = title
        }
        return info
    }

    func testParsesACompleteWindowRecord() throws {
        let record = try XCTUnwrap(
            WindowParser.parse(windowInfo(), bundleIdentifier: { _ in "com.apple.Safari" }))

        XCTAssertEqual(record.windowNumber, 42)
        XCTAssertEqual(record.ownerPid, 501)
        XCTAssertEqual(record.applicationName, "Safari")
        XCTAssertEqual(record.applicationBundleId, "com.apple.Safari")
        XCTAssertEqual(record.title, "Billing Settings")
        XCTAssertTrue(record.titleAvailable)
        XCTAssertEqual(record.bounds, RectRecord(x: 100, y: 80, width: 1200, height: 800))
        XCTAssertTrue(record.isOnScreen)
        XCTAssertEqual(record.layer, 0)
    }

    func testAWithheldTitleIsNotAnEmptyTitle() throws {
        // macOS omits `kCGWindowName` entirely without a Screen Recording
        // grant. Reporting that as "" would make the picker show a list of
        // blank rows and give no clue why.
        let withheld = try XCTUnwrap(
            WindowParser.parse(windowInfo(includeName: false), bundleIdentifier: { _ in nil }))
        XCTAssertFalse(withheld.titleAvailable)
        XCTAssertNil(withheld.title)

        let empty = try XCTUnwrap(
            WindowParser.parse(windowInfo(name: ""), bundleIdentifier: { _ in nil }))
        XCTAssertTrue(empty.titleAvailable)
        XCTAssertEqual(empty.title, "")
    }

    func testRejectsRecordsWithoutAnIdentity() {
        var missingNumber = windowInfo()
        missingNumber.removeValue(forKey: WindowInfoKey.number)
        XCTAssertNil(WindowParser.parse(missingNumber, bundleIdentifier: { _ in nil }))

        var missingOwner = windowInfo()
        missingOwner.removeValue(forKey: WindowInfoKey.ownerPID)
        XCTAssertNil(WindowParser.parse(missingOwner, bundleIdentifier: { _ in nil }))

        var missingBounds = windowInfo()
        missingBounds.removeValue(forKey: WindowInfoKey.bounds)
        XCTAssertNil(WindowParser.parse(missingBounds, bundleIdentifier: { _ in nil }))
    }

    func testParsesBoundsHandedBackAsDoubles() throws {
        let record = try XCTUnwrap(
            WindowParser.parse(
                windowInfo(bounds: ["X": -1600.0, "Y": 40.5, "Width": 1000.0, "Height": 700.0]),
                bundleIdentifier: { _ in nil }
            ))
        XCTAssertEqual(record.bounds, RectRecord(x: -1600, y: 40.5, width: 1000, height: 700))
    }

    func testWindowIsAssignedTheDisplayHoldingItsCentre() {
        let primary = DisplayRecord(
            displayNumber: 1,
            bounds: RectRecord(x: 0, y: 0, width: 1728, height: 1117),
            scaleFactor: 2,
            isPrimary: true
        )
        let secondary = DisplayRecord(
            displayNumber: 2,
            bounds: RectRecord(x: -1920, y: -120, width: 1920, height: 1080),
            scaleFactor: 1,
            isPrimary: false
        )

        XCTAssertEqual(
            WindowParser.displayNumber(
                for: RectRecord(x: -1600, y: 40, width: 1000, height: 700),
                displays: [primary, secondary]
            ),
            2
        )
        XCTAssertEqual(
            WindowParser.displayNumber(
                for: RectRecord(x: 100, y: 80, width: 1200, height: 800),
                displays: [primary, secondary]
            ),
            1
        )
    }

    func testWindowStraddlingTwoDisplaysFollowsItsCentre() {
        let left = DisplayRecord(
            displayNumber: 2,
            bounds: RectRecord(x: -1920, y: 0, width: 1920, height: 1080),
            scaleFactor: 1,
            isPrimary: false
        )
        let right = DisplayRecord(
            displayNumber: 1,
            bounds: RectRecord(x: 0, y: 0, width: 1728, height: 1117),
            scaleFactor: 2,
            isPrimary: true
        )
        // Origin on the left display, centre on the right one.
        XCTAssertEqual(
            WindowParser.displayNumber(
                for: RectRecord(x: -200, y: 100, width: 1000, height: 600),
                displays: [left, right]
            ),
            1
        )
    }

    func testWindowOnNoKnownDisplayFallsBackToPrimary() {
        let primary = DisplayRecord(
            displayNumber: 7,
            bounds: RectRecord(x: 0, y: 0, width: 100, height: 100),
            scaleFactor: 1,
            isPrimary: true
        )
        XCTAssertEqual(
            WindowParser.displayNumber(
                for: RectRecord(x: 9000, y: 9000, width: 10, height: 10),
                displays: [primary]
            ),
            7
        )
        XCTAssertNil(
            WindowParser.displayNumber(
                for: RectRecord(x: 0, y: 0, width: 10, height: 10),
                displays: []
            ))
    }

    func testTitlesWithheldOnlyWhenEveryWindowLacksATitle() throws {
        let withTitle = try XCTUnwrap(
            WindowParser.parse(windowInfo(), bundleIdentifier: { _ in nil }))
        let withoutTitle = try XCTUnwrap(
            WindowParser.parse(windowInfo(includeName: false), bundleIdentifier: { _ in nil }))

        XCTAssertTrue(WindowParser.titlesWithheld([withoutTitle, withoutTitle]))
        XCTAssertFalse(WindowParser.titlesWithheld([withoutTitle, withTitle]))
        // Vacuously false: no windows is not evidence of a missing grant.
        XCTAssertFalse(WindowParser.titlesWithheld([]))
    }

    func testSnapshotSerialisesForTheHostSchema() throws {
        let window = try XCTUnwrap(
            WindowParser.parse(windowInfo(), bundleIdentifier: { _ in "com.apple.Safari" }))
        let display = DisplayRecord(
            displayNumber: 1,
            bounds: RectRecord(x: 0, y: 0, width: 1728, height: 1117),
            scaleFactor: 2,
            isPrimary: true
        )
        let snapshot = WindowSnapshotData(
            windows: WindowParser.assignDisplays([window], displays: [display]),
            displays: [display],
            screenLocked: false,
            capturedAt: 1_700_000_000_000
        )

        let object = snapshot.jsonObject
        XCTAssertEqual(object["screenLocked"] as? Bool, false)
        XCTAssertEqual(object["titlesWithheld"] as? Bool, false)
        XCTAssertEqual(object["capturedAt"] as? Int, 1_700_000_000_000)

        let windows = try XCTUnwrap(object["windows"] as? [[String: Any]])
        XCTAssertEqual(windows.count, 1)
        XCTAssertEqual(windows[0]["displayNumber"] as? Int, 1)
        XCTAssertEqual(windows[0]["windowNumber"] as? Int, 42)

        _ = try JSONSerialization.data(withJSONObject: object, options: [])
    }

    func testAbsentBundleIdentifierSerialisesAsNull() throws {
        let window = try XCTUnwrap(
            WindowParser.parse(windowInfo(), bundleIdentifier: { _ in nil }))
        XCTAssertTrue(window.jsonObject["applicationBundleId"] is NSNull)
    }
}
