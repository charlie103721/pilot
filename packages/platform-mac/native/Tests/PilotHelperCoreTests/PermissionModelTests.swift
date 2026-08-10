import Foundation
import XCTest

@testable import PilotHelperCore

/// Covers the permission logic that is a pure function of its input.
///
/// This is the part of PR-011's Swift that the Mac batch can actually prove.
/// The framework calls in `PermissionProbes.swift` are not covered by anything
/// — no test here reaches TCC, by design.
final class PermissionModelTests: XCTestCase {
    func testCaptureAuthorizationMapsAllFourStates() {
        // AVAuthorizationStatus: 0 notDetermined, 1 restricted, 2 denied, 3 authorized.
        XCTAssertEqual(PermissionStateMapper.fromCaptureAuthorization(0), .unknown)
        XCTAssertEqual(PermissionStateMapper.fromCaptureAuthorization(1), .restricted)
        XCTAssertEqual(PermissionStateMapper.fromCaptureAuthorization(2), .denied)
        XCTAssertEqual(PermissionStateMapper.fromCaptureAuthorization(3), .granted)
    }

    func testSpeechAuthorizationMapsAllFourStates() {
        // SFSpeechRecognizerAuthorizationStatus swaps 1 and 2 relative to
        // AVAuthorizationStatus. Getting this wrong reports a policy
        // restriction as a user refusal, which sends the user to a System
        // Settings switch they are not allowed to touch.
        XCTAssertEqual(PermissionStateMapper.fromSpeechAuthorization(0), .unknown)
        XCTAssertEqual(PermissionStateMapper.fromSpeechAuthorization(1), .denied)
        XCTAssertEqual(PermissionStateMapper.fromSpeechAuthorization(2), .restricted)
        XCTAssertEqual(PermissionStateMapper.fromSpeechAuthorization(3), .granted)
    }

    func testTheTwoAuthorizationMappersDisagreeWhereTheAPIsDo() {
        XCTAssertNotEqual(
            PermissionStateMapper.fromCaptureAuthorization(1),
            PermissionStateMapper.fromSpeechAuthorization(1)
        )
        XCTAssertNotEqual(
            PermissionStateMapper.fromCaptureAuthorization(2),
            PermissionStateMapper.fromSpeechAuthorization(2)
        )
    }

    func testOutOfRangeAuthorizationIsUnknownNotDenied() {
        XCTAssertEqual(PermissionStateMapper.fromCaptureAuthorization(99), .unknown)
        XCTAssertEqual(PermissionStateMapper.fromSpeechAuthorization(-1), .unknown)
    }

    func testUnaskedBooleanPermissionIsUnknownNotDenied() {
        XCTAssertEqual(
            PermissionStateMapper.fromBoolean(granted: false, promptRaised: false),
            .unknown
        )
    }

    func testRefusedBooleanPermissionIsDenied() {
        XCTAssertEqual(
            PermissionStateMapper.fromBoolean(granted: false, promptRaised: true),
            .denied
        )
    }

    func testGrantedBooleanPermissionIsGrantedRegardlessOfPrompting() {
        XCTAssertEqual(
            PermissionStateMapper.fromBoolean(granted: true, promptRaised: false),
            .granted
        )
        XCTAssertEqual(
            PermissionStateMapper.fromBoolean(granted: true, promptRaised: true),
            .granted
        )
    }

    func testOnlyUnknownCanBeRequested() {
        XCTAssertTrue(PermissionStateMapper.canRequest(.unknown))
        XCTAssertFalse(PermissionStateMapper.canRequest(.denied))
        XCTAssertFalse(PermissionStateMapper.canRequest(.restricted))
        XCTAssertFalse(PermissionStateMapper.canRequest(.granted))
    }

    func testEveryPermissionKindHasADistinctSettingsAnchor() {
        let urls = PermissionKind.allCases.map { PermissionSettingsTarget.url(for: $0) }
        XCTAssertEqual(Set(urls).count, PermissionKind.allCases.count)
        for url in urls {
            XCTAssertTrue(url.hasPrefix("x-apple.systempreferences:"))
        }
    }

    func testPermissionKindRawValuesMatchTheSharedContract() {
        // These strings are the wire contract with `PERMISSION_KINDS` in
        // `@pilot/shared`. A rename on either side is a silent mismatch.
        XCTAssertEqual(
            Set(PermissionKind.allCases.map { $0.rawValue }),
            ["screen-recording", "accessibility", "microphone", "speech-recognition"]
        )
    }

    func testPermissionStateRawValuesMatchTheSharedContract() {
        XCTAssertEqual(PermissionState.unknown.rawValue, "unknown")
        XCTAssertEqual(PermissionState.denied.rawValue, "denied")
        XCTAssertEqual(PermissionState.restricted.rawValue, "restricted")
        XCTAssertEqual(PermissionState.granted.rawValue, "granted")
    }

    func testProbeSerialisesEveryFieldTheHostSchemaRequires() throws {
        let probe = PermissionProbe(
            kind: .microphone,
            state: .restricted,
            canRequest: false,
            api: .avAuthorization,
            raw: "1",
            restrictedRepresentable: true,
            requiresRelaunch: false
        )
        let object = probe.jsonObject
        XCTAssertEqual(object["kind"] as? String, "microphone")
        XCTAssertEqual(object["state"] as? String, "restricted")
        XCTAssertEqual(object["canRequest"] as? Bool, false)
        XCTAssertEqual(object["api"] as? String, "av-authorization")
        XCTAssertEqual(object["raw"] as? String, "1")
        XCTAssertEqual(object["restrictedRepresentable"] as? Bool, true)
        XCTAssertEqual(object["requiresRelaunch"] as? Bool, false)

        // The host parses with a strict schema, so it must survive a round trip.
        _ = try JSONSerialization.data(withJSONObject: object, options: [])
    }
}
