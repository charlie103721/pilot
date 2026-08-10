import Foundation
import XCTest

@testable import PilotHelperCore

/// Covers the pure half of attribution: locating the bundle a helper is
/// running inside. The verdict itself is host-side TypeScript, and is covered
/// by `test/attribution.test.ts`.
final class AttributionTests: XCTestCase {
    func testFindsTheEnclosingApplicationBundle() {
        XCTAssertEqual(
            BundlePath.enclosingAppBundle(of: "/Applications/Pilot.app/Contents/MacOS/PilotHelper"),
            "/Applications/Pilot.app"
        )
    }

    func testFindsABundleSeveralDirectoriesUp() {
        XCTAssertEqual(
            BundlePath.enclosingAppBundle(
                of: "/Applications/Pilot.app/Contents/Resources/helper/PilotHelper"),
            "/Applications/Pilot.app"
        )
    }

    func testPrefersTheNearestBundleWhenBundlesAreNested() {
        // The inner bundle is the one that would carry its own TCC identity,
        // so it is the one that must be reported. Naming the outer bundle
        // would conceal exactly the nesting that causes misattribution.
        XCTAssertEqual(
            BundlePath.enclosingAppBundle(
                of: "/Applications/Pilot.app/Contents/Library/Inner.app/Contents/MacOS/Helper"),
            "/Applications/Pilot.app/Contents/Library/Inner.app"
        )
    }

    func testLooseExecutableHasNoEnclosingBundle() {
        // The development layout: run straight out of the SwiftPM build
        // directory. The host reports `unknown`, not a failure.
        XCTAssertNil(
            BundlePath.enclosingAppBundle(
                of: "/Users/dev/pilot/packages/platform-mac/native/.build/debug/PilotHelper")
        )
    }

    func testADirectoryMerelyContainingAppIsNotABundle() {
        XCTAssertNil(BundlePath.enclosingAppBundle(of: "/Users/dev/apps/things/PilotHelper"))
        XCTAssertNil(BundlePath.enclosingAppBundle(of: "/Users/dev/.app/PilotHelper"))
    }

    func testRelativePathsAreHandled() {
        XCTAssertEqual(
            BundlePath.enclosingAppBundle(of: "Pilot.app/Contents/MacOS/PilotHelper"),
            "Pilot.app"
        )
    }

    func testIsAppBundleRecognisesBundleDirectories() {
        XCTAssertTrue(BundlePath.isAppBundle("/Applications/Pilot.app"))
        XCTAssertFalse(BundlePath.isAppBundle("/Applications/Pilot.app/Contents/MacOS"))
        XCTAssertFalse(BundlePath.isAppBundle("/usr/local/bin"))
        XCTAssertFalse(BundlePath.isAppBundle(".app"))
    }

    func testEvidenceSerialisesUnavailableFieldsAsNull() throws {
        // The host schema is strict and distinguishes null from absent: a
        // missing key would fail validation, and an omitted responsible pid
        // must read as "could not determine", never as zero.
        let evidence = AttributionEvidence(
            helperPid: 4321,
            parentPid: 1234,
            helperExecutablePath: "/Applications/Pilot.app/Contents/MacOS/PilotHelper",
            helperBundleIdentifier: nil,
            enclosingAppBundlePath: "/Applications/Pilot.app",
            enclosingAppBundleIdentifier: "com.pilot.app",
            responsibleProcessPid: nil,
            responsibleProcessQueried: false,
            mainBundleIsApp: false
        )
        let object = evidence.jsonObject

        XCTAssertEqual(object["helperPid"] as? Int, 4321)
        XCTAssertEqual(object["parentPid"] as? Int, 1234)
        XCTAssertTrue(object["helperBundleIdentifier"] is NSNull)
        XCTAssertTrue(object["responsibleProcessPid"] is NSNull)
        XCTAssertEqual(object["responsibleProcessQueried"] as? Bool, false)
        XCTAssertEqual(object["enclosingAppBundleIdentifier"] as? String, "com.pilot.app")

        let data = try JSONSerialization.data(withJSONObject: object, options: [])
        let decoded = try JSONSerialization.jsonObject(with: data) as? [String: Any]
        XCTAssertNotNil(decoded)
        XCTAssertTrue(decoded?["responsibleProcessPid"] is NSNull)
    }
}
