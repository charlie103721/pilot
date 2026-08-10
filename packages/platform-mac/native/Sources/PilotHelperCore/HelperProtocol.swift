import Foundation

/// JSON message bodies carried by a frame.
///
/// Mirrors `packages/platform-mac/src/protocol/messages.ts`. Payloads are
/// arbitrary JSON, so they are built with `JSONSerialization` rather than
/// `Codable`: the helper never needs to model the host's payload types, only
/// its own.
public enum HelperProtocol {
    public static let version = 1

    /// Operations this helper implements. PR-012 onward extends this list.
    ///
    /// Kept in exact agreement with `HELPER_OPERATIONS` in
    /// `packages/platform-mac/src/protocol/operations.ts`. Adding cases does
    /// not change `version`: an operation the other side does not know is
    /// already a typed `invalid-request` in both directions.
    public enum Operation: String {
        case health
        case echo
        // PR-011
        case permissionsStatus = "permissions.status"
        case permissionsSnapshot = "permissions.snapshot"
        case permissionsRequest = "permissions.request"
        case permissionsOpenSettings = "permissions.open-settings"
        case permissionsAttribution = "permissions.attribution"
        case windowsList = "windows.list"
        case windowsGet = "windows.get"
        // PR-013
        case accessibilitySample = "accessibility.sample"
        case accessibilityElementAt = "accessibility.element-at"
        // PR-014
        case speechInputAvailability = "speech.input.availability"
        case speechInputStart = "speech.input.start"
        case speechInputStop = "speech.input.stop"
        case speechInputCancel = "speech.input.cancel"
        case speechInputPoll = "speech.input.poll"
        case speechOutputAvailability = "speech.output.availability"
        case speechOutputSpeak = "speech.output.speak"
        case speechOutputStop = "speech.output.stop"
        case speechOutputPoll = "speech.output.poll"
    }

    public static let readyEventName = "helper.ready"

    public static func now() -> Int {
        Int(Date().timeIntervalSince1970 * 1000)
    }

    public static func encode(_ object: [String: Any]) throws -> String {
        let data = try JSONSerialization.data(withJSONObject: object, options: [.sortedKeys])
        return String(decoding: data, as: UTF8.self)
    }

    public static func requestMessage(id: String, op: String, payload: [String: Any]) -> [String: Any] {
        [
            "kind": "request",
            "protocolVersion": version,
            "id": id,
            "op": op,
            "issuedAt": now(),
            "payload": payload,
        ]
    }

    public static func successMessage(id: String, op: String, payload: [String: Any]) -> [String: Any] {
        [
            "kind": "response",
            "protocolVersion": version,
            "id": id,
            "op": op,
            "issuedAt": now(),
            "ok": true,
            "payload": payload,
        ]
    }

    public static func failureMessage(
        id: String,
        op: String,
        code: String,
        domain: String,
        message: String,
        userMessage: String = "The macOS helper could not run that operation.",
        retryable: Bool = false
    ) -> [String: Any] {
        [
            "kind": "response",
            "protocolVersion": version,
            "id": id,
            "op": op,
            "issuedAt": now(),
            "ok": false,
            "error": [
                "name": "PilotError",
                "code": code,
                "domain": domain,
                "message": message,
                "userMessage": userMessage,
                "retryable": retryable,
            ] as [String: Any],
        ]
    }

    public static func eventMessage(id: String, op: String, payload: [String: Any]) -> [String: Any] {
        [
            "kind": "event",
            "protocolVersion": version,
            "id": id,
            "op": op,
            "issuedAt": now(),
            "payload": payload,
        ]
    }
}

/// A decoded request the helper is expected to answer.
public struct HelperRequest {
    public let id: String
    public let op: String
    public let payload: [String: Any]
}

public enum HelperMessageError: Error, Equatable {
    case notJSON
    case notAnObject
    case versionMismatch(Int?)
    case missingField(String)
    case notARequest(String)
}

extension HelperProtocol {
    /// Parses a frame's message body into a request, or explains why it could not.
    public static func decodeRequest(_ message: [UInt8]) throws -> HelperRequest {
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: Data(message), options: [])
        } catch {
            throw HelperMessageError.notJSON
        }
        guard let dictionary = object as? [String: Any] else {
            throw HelperMessageError.notAnObject
        }
        let receivedVersion = dictionary["protocolVersion"] as? Int
        guard receivedVersion == version else {
            throw HelperMessageError.versionMismatch(receivedVersion)
        }
        guard let kind = dictionary["kind"] as? String else {
            throw HelperMessageError.missingField("kind")
        }
        guard kind == "request" else {
            throw HelperMessageError.notARequest(kind)
        }
        guard let id = dictionary["id"] as? String, !id.isEmpty else {
            throw HelperMessageError.missingField("id")
        }
        guard let op = dictionary["op"] as? String, !op.isEmpty else {
            throw HelperMessageError.missingField("op")
        }
        let payload = dictionary["payload"] as? [String: Any] ?? [:]
        return HelperRequest(id: id, op: op, payload: payload)
    }
}
