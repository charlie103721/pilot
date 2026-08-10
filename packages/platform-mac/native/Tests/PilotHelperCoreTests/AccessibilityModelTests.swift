import Foundation
import XCTest

@testable import PilotHelperCore

/// The pure half of PR-013: the secure-field classifier, the label preference
/// order, the AppKit coordinate flip, the text clamps and the JSON shape.
///
/// The ApplicationServices calls in `AccessibilityProbes.swift` are *not*
/// covered — there is no Mac and no Swift toolchain here (runbook amendment 8),
/// and these tests have never been executed either. They exist so that the
/// moment a Mac runs `swift test`, the logic that decides whether a password
/// field is recognised is checked rather than assumed.
final class AccessibilityModelTests: XCTestCase {

    // MARK: - Secure fields

    func testRecognisesSecureRole() {
        let verdict = SecureFieldClassifier.classify(role: "AXSecureTextField", subrole: nil)
        XCTAssertTrue(verdict.isSecure)
        XCTAssertEqual(verdict.basis, .role)
        XCTAssertNil(verdict.ancestorDepth)
    }

    /// How AppKit's text system and WebKit actually mark a password input: the
    /// role stays `AXTextField` and the *subrole* carries the answer. Missing
    /// this case would leave every web password field unrecognised.
    func testRecognisesSecureSubrole() {
        let verdict = SecureFieldClassifier.classify(
            role: "AXTextField", subrole: "AXSecureTextField")
        XCTAssertTrue(verdict.isSecure)
        XCTAssertEqual(verdict.basis, .subrole)
    }

    func testRecognisesSecureAncestorWithinDepth() {
        let verdict = SecureFieldClassifier.classify(
            role: "AXStaticText",
            subrole: nil,
            ancestors: [
                AccessibilityRolePair(role: "AXGroup", subrole: nil),
                AccessibilityRolePair(role: "AXTextField", subrole: "AXSecureTextField"),
            ]
        )
        XCTAssertTrue(verdict.isSecure)
        XCTAssertEqual(verdict.basis, .ancestor)
        XCTAssertEqual(verdict.ancestorDepth, 2)
    }

    func testStopsWalkingAtMaxDepth() {
        var ancestors: [AccessibilityRolePair] = []
        for _ in 0..<SecureFieldClassifier.maxAncestorDepth {
            ancestors.append(AccessibilityRolePair(role: "AXGroup", subrole: nil))
        }
        ancestors.append(AccessibilityRolePair(role: "AXSecureTextField", subrole: nil))
        let verdict = SecureFieldClassifier.classify(
            role: "AXStaticText", subrole: nil, ancestors: ancestors)
        XCTAssertFalse(verdict.isSecure, "the walk is bounded; it runs on the 30 Hz path")
        XCTAssertEqual(verdict.basis, .none)
    }

    /// The honesty test. `basis == .none` is the absence of evidence, and these
    /// are the cases the product must not claim to cover (system-design §14).
    func testDoesNotGuessSecrecyFromLabels() {
        for label in ["Password", "API key", "Recovery phrase", "Mot de passe"] {
            let verdict = SecureFieldClassifier.classify(role: "AXTextField", subrole: nil)
            XCTAssertFalse(
                verdict.isSecure,
                "a field labelled \"\(label)\" that macOS does not mark secure is not claimed secure")
            XCTAssertEqual(verdict.basis, .none)
        }
    }

    func testNonSecureElementIsNotSecure() {
        let verdict = SecureFieldClassifier.classify(role: "AXButton", subrole: nil)
        XCTAssertEqual(verdict, SecureFieldVerdict.notSecure)
    }

    // MARK: - Redaction

    func testSecureValueIsNeverCarried() {
        let element = AccessibilityElementRecord(
            role: "AXTextField",
            subrole: "AXSecureTextField",
            label: "Password",
            value: "hunter2",
            bounds: RectRecord(x: 0, y: 0, width: 10, height: 10),
            secure: SecureFieldClassifier.classify(
                role: "AXTextField", subrole: "AXSecureTextField"),
            ownerPid: 501
        )
        XCTAssertNil(element.redacted(includeValue: true).value)
        XCTAssertNil(element.redacted(includeValue: false).value)
        XCTAssertEqual(element.redacted(includeValue: true).label, "Password")
    }

    func testNonSecureValueIsCarriedOnlyWhenAsked() {
        let element = AccessibilityElementRecord(
            role: "AXButton",
            subrole: nil,
            label: "Auto Renew",
            value: "on",
            bounds: nil,
            secure: .notSecure,
            ownerPid: 501
        )
        XCTAssertEqual(element.redacted(includeValue: true).value, "on")
        XCTAssertNil(element.redacted(includeValue: false).value)
    }

    // MARK: - Text

    func testLabelPrefersTitleThenDescriptionThenPlaceholder() {
        XCTAssertEqual(
            AccessibilityText.label(
                title: "Save", description: "Saves the file", titleElementValue: nil,
                placeholder: "Name"),
            "Save")
        XCTAssertEqual(
            AccessibilityText.label(
                title: "  ", description: "Saves the file", titleElementValue: nil,
                placeholder: "Name"),
            "Saves the file")
        XCTAssertEqual(
            AccessibilityText.label(
                title: nil, description: nil, titleElementValue: "Untitled", placeholder: "Name"),
            "Untitled")
        XCTAssertEqual(
            AccessibilityText.label(
                title: nil, description: "", titleElementValue: nil, placeholder: "Name"),
            "Name")
        XCTAssertNil(
            AccessibilityText.label(
                title: nil, description: nil, titleElementValue: nil, placeholder: nil))
    }

    func testNormalizeTrimsEmptiesAndClamps() {
        XCTAssertNil(AccessibilityText.normalize("   "))
        XCTAssertNil(AccessibilityText.normalize(nil))
        XCTAssertEqual(AccessibilityText.normalize("  hello "), "hello")
        let long = String(repeating: "a", count: AccessibilityText.maxLabelLength + 50)
        XCTAssertEqual(
            AccessibilityText.normalize(long)?.count, AccessibilityText.maxLabelLength,
            "the host schema rejects anything longer; the helper clamps rather than fails")
    }

    // MARK: - Geometry

    /// The one conversion the pointer path needs. Wrong flips are invisible in
    /// the middle of a screen and maximal at its edges.
    func testFlipsAppKitCoordinates() {
        let height = 1117.0
        XCTAssertEqual(
            AccessibilityGeometry.flippedFromAppKit(PointRecord(x: 10, y: 0), primaryDisplayHeight: height),
            PointRecord(x: 10, y: 1117),
            "AppKit's y = 0 is the bottom of the primary display")
        XCTAssertEqual(
            AccessibilityGeometry.flippedFromAppKit(
                PointRecord(x: 10, y: height), primaryDisplayHeight: height),
            PointRecord(x: 10, y: 0))
        XCTAssertEqual(
            AccessibilityGeometry.flippedFromAppKit(
                PointRecord(x: 10, y: 558.5), primaryDisplayHeight: height),
            PointRecord(x: 10, y: 558.5),
            "the midpoint is its own image, which is why a wrong flip hides there")
    }

    /// A point on a display above the primary has a negative y in the
    /// top-left-origin space, and the flip must preserve that rather than
    /// clamping it into the primary display.
    func testFlipPreservesPointsOutsideThePrimaryDisplay() {
        let flipped = AccessibilityGeometry.flippedFromAppKit(
            PointRecord(x: -200, y: 1500), primaryDisplayHeight: 1117)
        XCTAssertEqual(flipped, PointRecord(x: -200, y: -383))
    }

    // MARK: - JSON

    func testElementJsonMatchesTheWireSchema() throws {
        let element = AccessibilityElementRecord(
            role: "AXTextField",
            subrole: "AXSecureTextField",
            label: "Password",
            value: nil,
            bounds: RectRecord(x: 400, y: 300, width: 220, height: 24),
            secure: SecureFieldClassifier.classify(
                role: "AXTextField", subrole: "AXSecureTextField"),
            ownerPid: 501
        )
        let json = element.jsonObject
        XCTAssertTrue(JSONSerialization.isValidJSONObject(json))
        XCTAssertEqual(json["role"] as? String, "AXTextField")
        XCTAssertEqual(json["isSecure"] as? Bool, true)
        XCTAssertEqual(json["secureBasis"] as? String, "subrole")
        XCTAssertTrue(json["value"] is NSNull)
        XCTAssertTrue(json["secureAncestorDepth"] is NSNull)
        XCTAssertEqual(json["ownerPid"] as? Int, 501)
    }

    func testPointerReadingJsonMatchesTheWireSchema() {
        let reading = PointerReading(
            point: PointRecord(x: 700.5, y: 480.25), source: .cgEvent, sampledAt: 1_700_000_000_000)
        let fields = reading.jsonFields
        XCTAssertEqual(fields["pointerSource"] as? String, "cg-event")
        XCTAssertEqual((fields["point"] as? [String: Any])?["x"] as? Double, 700.5)
        XCTAssertEqual(fields["sampledAt"] as? Int, 1_700_000_000_000)
    }

    func testOutcomeRawValuesMatchTheHostEnumeration() {
        XCTAssertEqual(ElementOutcome.reported.rawValue, "reported")
        XCTAssertEqual(ElementOutcome.noElement.rawValue, "no-element")
        XCTAssertEqual(ElementOutcome.notTrusted.rawValue, "not-trusted")
        XCTAssertEqual(ElementOutcome.queryFailed.rawValue, "query-failed")
        XCTAssertEqual(ElementOutcome.notRequested.rawValue, "not-requested")
        XCTAssertEqual(SecureFieldBasis.none.rawValue, "none")
        XCTAssertEqual(PointerSource.cgEvent.rawValue, "cg-event")
    }
}
