import Foundation
import XCTest

@testable import PilotHelperCore

final class HelperServerTests: XCTestCase {
    private func requestFrame(
        id: String,
        op: String,
        payload: [String: Any] = [:],
        binary: [UInt8] = []
    ) throws -> Frame {
        let message = HelperProtocol.requestMessage(id: id, op: op, payload: payload)
        let text = try HelperProtocol.encode(message)
        return Frame(messageText: text, binary: binary)
    }

    private func replyBody(_ outcome: HelperOutcome) throws -> [String: Any] {
        guard case .reply(let frame) = outcome else {
            XCTFail("expected a reply")
            return [:]
        }
        let object = try JSONSerialization.jsonObject(with: Data(frame.message), options: [])
        guard let dictionary = object as? [String: Any] else {
            XCTFail("expected a JSON object")
            return [:]
        }
        return dictionary
    }

    func testHealthReportsVersionAndProtocol() throws {
        let server = HelperServer(helperVersion: "9.9.9", processIdentifier: 4321)
        let frame = try requestFrame(id: "req-1", op: "health")
        let response = try replyBody(server.handle(frame: frame))

        XCTAssertEqual(response["kind"] as? String, "response")
        XCTAssertEqual(response["id"] as? String, "req-1")
        XCTAssertEqual(response["op"] as? String, "health")
        XCTAssertEqual(response["ok"] as? Bool, true)
        XCTAssertEqual(response["protocolVersion"] as? Int, HelperProtocol.version)

        let payload = response["payload"] as? [String: Any]
        XCTAssertEqual(payload?["status"] as? String, "ok")
        XCTAssertEqual(payload?["helperVersion"] as? String, "9.9.9")
        XCTAssertEqual(payload?["pid"] as? Int, 4321)
        XCTAssertNotNil(payload?["uptimeMs"] as? Int)
    }

    func testEchoReturnsTextAndBinary() throws {
        let server = HelperServer(helperVersion: "0.1.0")
        let payload: [UInt8] = [1, 2, 3, 4, 5]
        let frame = try requestFrame(id: "req-2", op: "echo", payload: ["text": "hi"], binary: payload)
        let outcome = server.handle(frame: frame)

        guard case .reply(let reply) = outcome else {
            XCTFail("expected a reply")
            return
        }
        XCTAssertEqual(reply.binary, payload)

        let response = try replyBody(outcome)
        let body = response["payload"] as? [String: Any]
        XCTAssertEqual(body?["text"] as? String, "hi")
        XCTAssertEqual(body?["binaryLength"] as? Int, payload.count)
    }

    func testUnknownOperationIsATypedFailure() throws {
        let server = HelperServer(helperVersion: "0.1.0")
        let frame = try requestFrame(id: "req-3", op: "nope")
        let response = try replyBody(server.handle(frame: frame))

        XCTAssertEqual(response["ok"] as? Bool, false)
        let error = response["error"] as? [String: Any]
        XCTAssertEqual(error?["name"] as? String, "PilotError")
        XCTAssertEqual(error?["code"] as? String, "invalid-request")
        XCTAssertEqual(error?["domain"] as? String, "ipc")
        XCTAssertEqual(error?["retryable"] as? Bool, false)
    }

    func testEchoWithoutTextIsATypedFailure() throws {
        let server = HelperServer(helperVersion: "0.1.0")
        let frame = try requestFrame(id: "req-4", op: "echo")
        let response = try replyBody(server.handle(frame: frame))

        XCTAssertEqual(response["ok"] as? Bool, false)
        XCTAssertEqual((response["error"] as? [String: Any])?["code"] as? String, "invalid-request")
    }

    func testProtocolVersionMismatchIsFatal() {
        let server = HelperServer(helperVersion: "0.1.0")
        let body =
            "{\"kind\":\"request\",\"protocolVersion\":99,\"id\":\"x\",\"op\":\"health\",\"issuedAt\":0,\"payload\":{}}"

        guard case .fatal = server.handle(frame: Frame(messageText: body)) else {
            XCTFail("expected a fatal outcome")
            return
        }
    }

    func testUnparsableMessageIsFatal() {
        let server = HelperServer(helperVersion: "0.1.0")

        guard case .fatal = server.handle(frame: Frame(messageText: "not json")) else {
            XCTFail("expected a fatal outcome")
            return
        }
    }

    func testNonRequestMessagesAreIgnored() throws {
        let server = HelperServer(helperVersion: "0.1.0")
        let message = HelperProtocol.eventMessage(id: "evt-1", op: "helper.ready", payload: [:])
        let text = try HelperProtocol.encode(message)

        guard case .ignore = server.handle(frame: Frame(messageText: text)) else {
            XCTFail("expected the message to be ignored")
            return
        }
    }

    func testReadyFrameIsAWellFormedEvent() throws {
        let server = HelperServer(helperVersion: "0.1.0", processIdentifier: 77)
        let frame = try server.readyFrame()
        let object = try JSONSerialization.jsonObject(with: Data(frame.message), options: [])
        let dictionary = object as? [String: Any]

        XCTAssertEqual(dictionary?["kind"] as? String, "event")
        XCTAssertEqual(dictionary?["op"] as? String, HelperProtocol.readyEventName)
        XCTAssertEqual(dictionary?["protocolVersion"] as? Int, HelperProtocol.version)

        let payload = dictionary?["payload"] as? [String: Any]
        XCTAssertEqual(payload?["pid"] as? Int, 77)
        XCTAssertEqual(payload?["helperVersion"] as? String, "0.1.0")
    }
}
