import Foundation
import XCTest

@testable import PilotHelperCore

/// The three PR-015 operations and the two PR-015 events, dispatched through
/// `HelperServer` with a stub `HotkeyService`.
///
/// A separate file from `HelperServerOperationsTests` on purpose: three sibling
/// PRs are editing this package concurrently, and a new file merges mechanically
/// where an edit to a shared test file does not.
final class HotkeyOperationsTests: XCTestCase {

    private final class StubHotkey: HotkeyService {
        var onKey: ((HotkeyKeyReport) -> Void)?
        var onTapChange: ((HotkeyTapChange, HotkeyStatus) -> Void)?

        var binding: HotkeyBinding = .defaultPushToTalk
        var tap: HotkeyTapState = .stopped
        var accessibilityTrusted = true
        var held = false
        var detail = ""
        var counters = HotkeyCounters()
        var startCalls: [HotkeyBinding] = []
        var stopCalls = 0
        var statusCalls = 0

        func start(binding: HotkeyBinding) -> HotkeyStatus {
            startCalls.append(binding)
            self.binding = binding
            tap = accessibilityTrusted ? .active : .accessibilityDenied
            return status()
        }

        func stop() -> HotkeyStatus {
            stopCalls += 1
            tap = .stopped
            held = false
            return status()
        }

        func status() -> HotkeyStatus {
            statusCalls += 1
            return HotkeyStatus(
                binding: binding,
                tap: tap,
                accessibilityTrusted: accessibilityTrusted,
                held: held,
                detail: detail,
                counters: counters
            )
        }
    }

    // MARK: - Helpers

    private func makeServer(hotkey: StubHotkey) -> HelperServer {
        HelperServer(
            helperVersion: "0.1.0",
            processIdentifier: 4321,
            hotkey: hotkey
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

    private func statusPayload(_ response: [String: Any]) throws -> [String: Any] {
        let payload = try XCTUnwrap(response["payload"] as? [String: Any])
        return try XCTUnwrap(payload["status"] as? [String: Any])
    }

    private let defaultBindingPayload: [String: Any] = [
        "keyCode": 61,
        "label": "Right Option",
        "isModifierKey": true,
        "requiredModifiers": [],
    ]

    // MARK: - Operations

    func testStartInstallsTheBindingAndReportsActive() throws {
        let hotkey = StubHotkey()
        let server = makeServer(hotkey: hotkey)

        let response = try answer(
            server, id: "r1", op: "hotkey.start", payload: ["binding": defaultBindingPayload])
        XCTAssertEqual(response["ok"] as? Bool, true)
        XCTAssertEqual(try statusPayload(response)["tap"] as? String, "active")
        XCTAssertEqual(hotkey.startCalls.count, 1)
        XCTAssertEqual(hotkey.startCalls.first?.keyCode, 61)
    }

    func testStartWithAMalformedBindingIsAnInvalidRequest() throws {
        let hotkey = StubHotkey()
        let server = makeServer(hotkey: hotkey)

        let response = try answer(
            server, id: "r1", op: "hotkey.start", payload: ["binding": ["keyCode": 61]])
        XCTAssertEqual(response["ok"] as? Bool, false)
        let error = try XCTUnwrap(response["error"] as? [String: Any])
        XCTAssertEqual(error["code"] as? String, "invalid-request")
        XCTAssertTrue(hotkey.startCalls.isEmpty)
    }

    func testAccessibilityDenialIsAStatusNotAnError() throws {
        // system-design §16: the user must keep a way to ask a question. A
        // missing permission is a reported state, so the host can render the
        // typed fallback instead of treating it as a crash.
        let hotkey = StubHotkey()
        hotkey.accessibilityTrusted = false
        let server = makeServer(hotkey: hotkey)

        let response = try answer(
            server, id: "r1", op: "hotkey.start", payload: ["binding": defaultBindingPayload])
        XCTAssertEqual(response["ok"] as? Bool, true)
        let status = try statusPayload(response)
        XCTAssertEqual(status["tap"] as? String, "accessibility-denied")
        XCTAssertEqual(status["accessibilityTrusted"] as? Bool, false)
    }

    func testStopAndStatusRoundTrip() throws {
        let hotkey = StubHotkey()
        let server = makeServer(hotkey: hotkey)

        _ = try answer(
            server, id: "r1", op: "hotkey.start", payload: ["binding": defaultBindingPayload])
        let stopped = try answer(server, id: "r2", op: "hotkey.stop")
        XCTAssertEqual(try statusPayload(stopped)["tap"] as? String, "stopped")
        XCTAssertEqual(hotkey.stopCalls, 1)

        let status = try answer(server, id: "r3", op: "hotkey.status")
        XCTAssertEqual(try statusPayload(status)["tap"] as? String, "stopped")
    }

    func testRebindingReplacesTheBinding() throws {
        let hotkey = StubHotkey()
        let server = makeServer(hotkey: hotkey)

        _ = try answer(
            server, id: "r1", op: "hotkey.start", payload: ["binding": defaultBindingPayload])
        let response = try answer(
            server, id: "r2", op: "hotkey.start",
            payload: [
                "binding": [
                    "keyCode": 105,
                    "label": "F13",
                    "isModifierKey": false,
                    "requiredModifiers": ["control"],
                ]
            ])
        let binding = try XCTUnwrap(try statusPayload(response)["binding"] as? [String: Any])
        XCTAssertEqual(binding["keyCode"] as? Int, 105)
        XCTAssertEqual(binding["requiredModifiers"] as? [String], ["control"])
    }

    // MARK: - Events

    func testKeyReportsBecomeHotkeyKeyEventFrames() throws {
        let hotkey = StubHotkey()
        let server = makeServer(hotkey: hotkey)
        var frames: [[String: Any]] = []
        server.onEvent = { frame in
            if let object = try? JSONSerialization.jsonObject(with: Data(frame.message)),
                let dictionary = object as? [String: Any]
            {
                frames.append(dictionary)
            }
        }

        hotkey.onKey?(
            HotkeyKeyReport(
                phase: .down, keyCode: 61, at: 1_700_000_000_000, sequence: 1, autorepeat: false))
        hotkey.onKey?(
            HotkeyKeyReport(
                phase: .up, keyCode: 61, at: 1_700_000_000_400, sequence: 2, autorepeat: false))

        XCTAssertEqual(frames.count, 2)
        XCTAssertEqual(frames.first?["kind"] as? String, "event")
        XCTAssertEqual(frames.first?["op"] as? String, "hotkey.key")
        let payload = try XCTUnwrap(frames.first?["payload"] as? [String: Any])
        XCTAssertEqual(payload["phase"] as? String, "down")
        XCTAssertEqual(payload["keyCode"] as? Int, 61)
        // Event ids must be distinct, or the host cannot tell a retransmission
        // from a new press.
        XCTAssertNotEqual(frames.first?["id"] as? String, frames.last?["id"] as? String)
    }

    func testTapChangesBecomeHotkeyTapEventFrames() throws {
        let hotkey = StubHotkey()
        let server = makeServer(hotkey: hotkey)
        var frames: [[String: Any]] = []
        server.onEvent = { frame in
            if let object = try? JSONSerialization.jsonObject(with: Data(frame.message)),
                let dictionary = object as? [String: Any]
            {
                frames.append(dictionary)
            }
        }

        hotkey.tap = .disabled
        hotkey.detail = "macOS disabled the tap: callback deadline exceeded"
        hotkey.onTapChange?(.disabledByTimeout, hotkey.status())

        let frame = try XCTUnwrap(frames.first)
        XCTAssertEqual(frame["op"] as? String, "hotkey.tap")
        let payload = try XCTUnwrap(frame["payload"] as? [String: Any])
        XCTAssertEqual(payload["change"] as? String, "disabled-by-timeout")
        let status = try XCTUnwrap(payload["status"] as? [String: Any])
        XCTAssertEqual(status["tap"] as? String, "disabled")
    }

    func testNoEventsAreProducedWithoutASink() {
        let hotkey = StubHotkey()
        _ = makeServer(hotkey: hotkey)
        // `onEvent` is nil: the report is dropped rather than crashing or
        // buffering. Tests and the XCTest target run in exactly this shape.
        hotkey.onKey?(
            HotkeyKeyReport(
                phase: .down, keyCode: 61, at: 0, sequence: 1, autorepeat: false))
    }

    func testShutdownStopsTheTapAndDetachesTheSink() {
        let hotkey = StubHotkey()
        let server = makeServer(hotkey: hotkey)
        server.onEvent = { _ in
            XCTFail("no event should be delivered after shutdown")
        }
        server.shutdown()
        XCTAssertEqual(hotkey.stopCalls, 1)
        XCTAssertNil(hotkey.onKey)
        XCTAssertNil(hotkey.onTapChange)
    }
}
