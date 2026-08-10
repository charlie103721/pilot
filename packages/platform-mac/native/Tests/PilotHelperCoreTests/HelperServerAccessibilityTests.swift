import Foundation
import XCTest

@testable import PilotHelperCore

/// The PR-013 operations dispatched through `HelperServer` with a stub
/// `AccessibilityService`, so request decoding, the include-element and
/// include-value switches, the scoping argument and response encoding are
/// covered without an accessibility grant and without a pointer.
///
/// A separate file from `HelperServerOperationsTests` on purpose: PR-012,
/// PR-014 and PR-015 are appending operations to the same server in parallel
/// worktrees, and separate files merge where one shared file conflicts.
///
/// Never executed — there is no Swift toolchain here (runbook amendment 8).
final class HelperServerAccessibilityTests: XCTestCase {

    private final class StubAccessibility: AccessibilityService {
        var trusted = true
        var reading = PointerReading(
            point: PointRecord(x: 730, y: 495), source: .cgEvent, sampledAt: 1_000)
        var lookup = ElementLookup(
            element: AccessibilityElementRecord(
                role: "AXButton",
                subrole: nil,
                label: "Auto Renew",
                value: "on",
                bounds: RectRecord(x: 700, y: 480, width: 60, height: 30),
                secure: .notSecure,
                ownerPid: 501
            ),
            outcome: .reported
        )
        var elementCalls: [(point: PointRecord, ownerPid: Int?, includeValue: Bool)] = []

        func isTrusted() -> Bool {
            trusted
        }

        func pointer() -> PointerReading {
            reading
        }

        func element(at point: PointRecord, ownerPid: Int?, includeValue: Bool) -> ElementLookup {
            elementCalls.append((point, ownerPid, includeValue))
            if !trusted {
                return .notTrusted
            }
            guard let element = lookup.element else {
                return lookup
            }
            return ElementLookup(
                element: element.redacted(includeValue: includeValue), outcome: lookup.outcome)
        }
    }

    private func makeServer(_ accessibility: StubAccessibility) -> HelperServer {
        HelperServer(
            helperVersion: "0.1.0",
            processIdentifier: 4321,
            accessibility: accessibility
        )
    }

    private func answer(
        _ server: HelperServer,
        id: String,
        op: String,
        payload: [String: Any] = [:]
    ) throws -> [String: Any] {
        let message = HelperProtocol.requestMessage(id: id, op: op, payload: payload)
        let text = try HelperProtocol.encode(message)
        let outcome = server.handle(frame: Frame(messageText: text))
        guard case .reply(let frame) = outcome else {
            XCTFail("expected a reply for \"\(op)\"")
            return [:]
        }
        let object = try JSONSerialization.jsonObject(with: Data(frame.message), options: [])
        return try XCTUnwrap(object as? [String: Any])
    }

    private func payload(_ response: [String: Any]) throws -> [String: Any] {
        try XCTUnwrap(response["payload"] as? [String: Any])
    }

    // MARK: - accessibility.sample

    func testSampleReportsPositionWithoutHitTestingByDefault() throws {
        let accessibility = StubAccessibility()
        let body = try payload(
            try answer(makeServer(accessibility), id: "a1", op: "accessibility.sample"))

        XCTAssertEqual((body["point"] as? [String: Any])?["x"] as? Double, 730)
        XCTAssertEqual(body["axTrusted"] as? Bool, true)
        XCTAssertEqual(body["outcome"] as? String, "not-requested")
        XCTAssertTrue(body["element"] is NSNull)
        XCTAssertTrue(accessibility.elementCalls.isEmpty, "no hit test was asked for")
    }

    func testSampleHitTestsThePointerPositionWhenAsked() throws {
        let accessibility = StubAccessibility()
        let body = try payload(
            try answer(
                makeServer(accessibility), id: "a2", op: "accessibility.sample",
                payload: ["includeElement": true, "ownerPid": 501]))

        XCTAssertEqual(body["outcome"] as? String, "reported")
        XCTAssertEqual((body["element"] as? [String: Any])?["label"] as? String, "Auto Renew")
        XCTAssertEqual(accessibility.elementCalls.count, 1)
        XCTAssertEqual(accessibility.elementCalls.first?.ownerPid ?? nil, 501)
        XCTAssertEqual(accessibility.elementCalls.first?.point, PointRecord(x: 730, y: 495))
    }

    /// Degraded mode (system-design §16): the position still arrives, only the
    /// element is missing, and the reason is named rather than implied.
    func testSampleStillReportsAPositionWhenAccessibilityIsDenied() throws {
        let accessibility = StubAccessibility()
        accessibility.trusted = false
        let body = try payload(
            try answer(
                makeServer(accessibility), id: "a3", op: "accessibility.sample",
                payload: ["includeElement": true]))

        XCTAssertEqual((body["point"] as? [String: Any])?["y"] as? Double, 495)
        XCTAssertEqual(body["axTrusted"] as? Bool, false)
        XCTAssertEqual(body["outcome"] as? String, "not-trusted")
        XCTAssertTrue(body["element"] is NSNull)
    }

    // MARK: - accessibility.element-at

    func testElementAtRequiresAPoint() throws {
        let response = try answer(
            makeServer(StubAccessibility()), id: "a4", op: "accessibility.element-at")
        XCTAssertEqual(response["ok"] as? Bool, false)
        XCTAssertEqual((response["error"] as? [String: Any])?["code"] as? String, "invalid-request")
    }

    func testElementAtPassesTheScopingPidThrough() throws {
        let accessibility = StubAccessibility()
        _ = try answer(
            makeServer(accessibility), id: "a5", op: "accessibility.element-at",
            payload: ["point": ["x": 120.5, "y": 340], "ownerPid": 777])

        XCTAssertEqual(accessibility.elementCalls.first?.point, PointRecord(x: 120.5, y: 340))
        XCTAssertEqual(accessibility.elementCalls.first?.ownerPid ?? nil, 777)
    }

    func testValuesAreOptInAndNeverCarriedForSecureFields() throws {
        let accessibility = StubAccessibility()
        accessibility.lookup = ElementLookup(
            element: AccessibilityElementRecord(
                role: "AXTextField",
                subrole: "AXSecureTextField",
                label: "Password",
                value: "hunter2",
                bounds: RectRecord(x: 400, y: 300, width: 220, height: 24),
                secure: SecureFieldClassifier.classify(
                    role: "AXTextField", subrole: "AXSecureTextField"),
                ownerPid: 501
            ),
            outcome: .reported
        )
        let body = try payload(
            try answer(
                makeServer(accessibility), id: "a6", op: "accessibility.element-at",
                payload: ["point": ["x": 500, "y": 310], "includeValue": true]))

        let element = try XCTUnwrap(body["element"] as? [String: Any])
        XCTAssertEqual(element["isSecure"] as? Bool, true)
        XCTAssertEqual(element["secureBasis"] as? String, "subrole")
        XCTAssertTrue(element["value"] is NSNull, "a secure value is never carried")
        XCTAssertEqual(element["label"] as? String, "Password")
    }

    func testNoElementIsDistinctFromNotTrusted() throws {
        let accessibility = StubAccessibility()
        accessibility.lookup = .noElement
        let body = try payload(
            try answer(
                makeServer(accessibility), id: "a7", op: "accessibility.element-at",
                payload: ["point": ["x": 0, "y": 0]]))

        XCTAssertEqual(body["outcome"] as? String, "no-element")
        XCTAssertEqual(body["axTrusted"] as? Bool, true)
    }
}
