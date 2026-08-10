import Foundation
import XCTest

@testable import PilotHelperCore

/// The three PR-012 operations dispatched through `HelperServer` with a stub
/// capture service: request decoding, response encoding, and the binary body
/// that carries the pixels.
///
/// Deliberately a separate file from `HelperServerOperationsTests`. PR-013 and
/// PR-014 are running in this package at the same time, and cross-lane issue 5
/// in `docs/runbook.md` is two lanes appending to one shared file and git
/// merging both texts cleanly.
final class CaptureOperationsTests: XCTestCase {

    private final class StubCapture: CaptureService {
        var startOutcome: CaptureStartOutcome
        var pullOutcome: CapturePullOutcome
        var stopOutcome = CaptureStopOutcome(
            stopped: true, delivered: 3, dropped: 1, discarded: 2)

        var startedWith: [CaptureConfiguration] = []
        var stoppedWith: [String?] = []
        var pulledWith: [(streamId: String, notBefore: Int?)] = []

        init() {
            startOutcome = CaptureStartOutcome(
                session: CaptureSessionData(
                    streamId: "cap-1",
                    windowNumber: 42,
                    width: 1440,
                    height: 960,
                    scaleFactor: 1.2,
                    sampleFps: 3,
                    encoding: .jpeg,
                    startedAt: 1_700_000_000_000
                ),
                failure: nil
            )
            pullOutcome = CapturePullOutcome(
                state: .streaming,
                streamId: "cap-1",
                frame: nil,
                remaining: 0,
                dropped: 0,
                delivered: 0,
                failure: nil
            )
        }

        func start(_ configuration: CaptureConfiguration) -> CaptureStartOutcome {
            startedWith.append(configuration)
            return startOutcome
        }

        func stop(streamId: String?) -> CaptureStopOutcome {
            stoppedWith.append(streamId)
            return stopOutcome
        }

        func pull(streamId: String, notBefore: Int?) -> CapturePullOutcome {
            pulledWith.append((streamId, notBefore))
            return pullOutcome
        }
    }

    private func makeServer(capture: CaptureService) -> HelperServer {
        return HelperServer(
            helperVersion: "0.1.0",
            processIdentifier: 4321,
            permissions: SystemPermissionService(),
            windows: SystemWindowService(),
            capture: capture
        )
    }

    /// Sends one request and returns the reply frame, message and binary alike.
    private func reply(
        _ server: HelperServer,
        id: String,
        op: String,
        payload: [String: Any] = [:]
    ) throws -> (message: [String: Any], binary: [UInt8]) {
        let request = HelperProtocol.requestMessage(id: id, op: op, payload: payload)
        let text = try HelperProtocol.encode(request)
        let outcome = server.handle(frame: Frame(messageText: text))
        guard case .reply(let frame) = outcome else {
            XCTFail("expected a reply for \"\(op)\"")
            return ([:], [])
        }
        let object = try JSONSerialization.jsonObject(with: Data(frame.message), options: [])
        let dictionary = try XCTUnwrap(object as? [String: Any])
        return (dictionary, frame.binary)
    }

    private func startPayload(_ overrides: [String: Any] = [:]) -> [String: Any] {
        var payload: [String: Any] = [
            "windowNumber": 42,
            "width": 1440,
            "height": 960,
            "sampleFps": 3.0,
            "includeCursor": false,
            "encoding": "jpeg",
            "quality": 0.9,
        ]
        for (key, value) in overrides {
            payload[key] = value
        }
        return payload
    }

    // MARK: - capture.start

    func testStartPassesTheResolvedSizeThroughUnchanged() throws {
        let capture = StubCapture()
        let server = makeServer(capture: capture)

        let response = try reply(server, id: "c1", op: "capture.start", payload: startPayload())

        XCTAssertEqual(response.message["ok"] as? Bool, true)
        let payload = try XCTUnwrap(response.message["payload"] as? [String: Any])
        let session = try XCTUnwrap(payload["session"] as? [String: Any])
        XCTAssertEqual(session["streamId"] as? String, "cap-1")
        XCTAssertEqual(session["windowNumber"] as? Int, 42)
        XCTAssertEqual(session["width"] as? Int, 1440)
        // The policy is the host's; the helper configures what it is told.
        XCTAssertEqual(capture.startedWith.first?.width, 1440)
        XCTAssertEqual(capture.startedWith.first?.height, 960)
        XCTAssertEqual(capture.startedWith.first?.windowNumber, 42)
    }

    func testStartWithoutTheRequiredFieldsIsATypedFailure() throws {
        let server = makeServer(capture: StubCapture())

        let response = try reply(server, id: "c2", op: "capture.start", payload: ["width": 100])

        XCTAssertEqual(response.message["ok"] as? Bool, false)
        let error = try XCTUnwrap(response.message["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "invalid-request")
    }

    func testAMissingWindowIsReportedAsWindowClosedRatherThanACaptureFailure() throws {
        let capture = StubCapture()
        capture.startOutcome = CaptureStartOutcome(
            session: nil,
            failure: "window 42 is not available for capture",
            failureCode: "window-closed"
        )
        let server = makeServer(capture: capture)

        let response = try reply(server, id: "c3", op: "capture.start", payload: startPayload())

        let error = try XCTUnwrap(response.message["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "window-closed")
        XCTAssertEqual(error["domain"] as? String, "observation")
    }

    func testALockedScreenRefusesToStart() throws {
        let capture = StubCapture()
        capture.startOutcome = CaptureStartOutcome(
            session: nil, failure: "the screen is locked", failureCode: "screen-locked")
        let server = makeServer(capture: capture)

        let response = try reply(server, id: "c4", op: "capture.start", payload: startPayload())

        XCTAssertEqual(
            (response.message["error"] as? [String: Any])?["code"] as? String, "screen-locked")
    }

    // MARK: - capture.stop

    func testStopReportsWhatTheStreamDidAndWhatItDiscarded() throws {
        let capture = StubCapture()
        let server = makeServer(capture: capture)

        let response = try reply(
            server, id: "c5", op: "capture.stop", payload: ["streamId": "cap-1"])

        let payload = try XCTUnwrap(response.message["payload"] as? [String: Any])
        XCTAssertEqual(payload["stopped"] as? Bool, true)
        XCTAssertEqual(payload["delivered"] as? Int, 3)
        XCTAssertEqual(payload["dropped"] as? Int, 1)
        XCTAssertEqual(payload["discarded"] as? Int, 2)
        XCTAssertEqual(capture.stoppedWith.first ?? nil, "cap-1")
    }

    func testStopWithoutAStreamIdStopsWhateverIsRunning() throws {
        let capture = StubCapture()
        let server = makeServer(capture: capture)

        _ = try reply(server, id: "c6", op: "capture.stop", payload: [:])

        XCTAssertEqual(capture.stoppedWith.count, 1)
        XCTAssertNil(capture.stoppedWith.first ?? nil)
    }

    // MARK: - capture.pull

    func testPullCarriesThePixelsInTheBinaryBodyAndTheLengthInTheMessage() throws {
        let capture = StubCapture()
        let pixels = [UInt8](repeating: 0xAB, count: 512)
        capture.pullOutcome = CapturePullOutcome(
            state: .streaming,
            streamId: "cap-1",
            frame: CaptureFrameRecord(
                sequence: 7,
                windowNumber: 42,
                capturedAt: 1_700_000_000_500,
                timestampFallback: false,
                width: 1440,
                height: 960,
                scaleFactor: 1.2,
                encoding: .jpeg,
                bytes: pixels,
                contentChanged: true
            ),
            remaining: 2,
            dropped: 1,
            delivered: 9,
            failure: nil
        )
        let server = makeServer(capture: capture)

        let response = try reply(
            server, id: "c7", op: "capture.pull", payload: ["streamId": "cap-1"])

        let payload = try XCTUnwrap(response.message["payload"] as? [String: Any])
        let frame = try XCTUnwrap(payload["frame"] as? [String: Any])
        XCTAssertEqual(frame["sequence"] as? Int, 7)
        XCTAssertEqual(frame["windowNumber"] as? Int, 42)
        XCTAssertEqual(frame["byteLength"] as? Int, 512)
        XCTAssertEqual(payload["remaining"] as? Int, 2)
        // The body length and the declared length must agree exactly: the host
        // drops the frame when they do not.
        XCTAssertEqual(response.binary.count, 512)
        XCTAssertEqual(response.binary.first, 0xAB)
    }

    func testPullWithNoFrameSendsNoBinaryBody() throws {
        let capture = StubCapture()
        capture.pullOutcome = CapturePullOutcome(
            state: .starting,
            streamId: "cap-1",
            frame: nil,
            remaining: 0,
            dropped: 0,
            delivered: 0,
            failure: nil
        )
        let server = makeServer(capture: capture)

        let response = try reply(
            server, id: "c8", op: "capture.pull", payload: ["streamId": "cap-1"])

        let payload = try XCTUnwrap(response.message["payload"] as? [String: Any])
        XCTAssertTrue(payload["frame"] is NSNull)
        XCTAssertEqual(response.binary.count, 0)
    }

    func testPullPassesTheFreshnessWatermarkThrough() throws {
        let capture = StubCapture()
        let server = makeServer(capture: capture)

        _ = try reply(
            server,
            id: "c9",
            op: "capture.pull",
            payload: ["streamId": "cap-1", "notBefore": 1_700_000_000_000]
        )

        XCTAssertEqual(capture.pulledWith.first?.notBefore, 1_700_000_000_000)
    }

    func testPullWithoutAStreamIdIsATypedFailure() throws {
        let server = makeServer(capture: StubCapture())

        let response = try reply(server, id: "c10", op: "capture.pull", payload: [:])

        XCTAssertEqual(response.message["ok"] as? Bool, false)
        XCTAssertEqual(
            (response.message["error"] as? [String: Any])?["code"] as? String, "invalid-request")
    }

    func testProtectedContentIsAStateAndNeverAFrame() throws {
        let capture = StubCapture()
        capture.pullOutcome = CapturePullOutcome(
            state: .protectedContent,
            streamId: "cap-1",
            frame: nil,
            remaining: 0,
            dropped: 0,
            delivered: 0,
            failure: nil
        )
        let server = makeServer(capture: capture)

        let response = try reply(
            server, id: "c11", op: "capture.pull", payload: ["streamId": "cap-1"])

        let payload = try XCTUnwrap(response.message["payload"] as? [String: Any])
        XCTAssertEqual(payload["state"] as? String, "protected")
        XCTAssertTrue(payload["frame"] is NSNull)
        XCTAssertEqual(response.binary.count, 0)
    }
}
