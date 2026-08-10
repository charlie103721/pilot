import Foundation

/// What the server wants done with a frame it just handled.
public enum HelperOutcome {
    /// Write this frame back to the host.
    case reply(Frame)
    /// The stream is unusable. Log and exit; the host's supervisor restarts us.
    case fatal(String)
    /// Nothing to send (for example, a message that is not a request).
    case ignore
}

/// The helper's request loop.
///
/// PR-003 implemented transport only: `health` (the host's startup handshake
/// and liveness probe) and `echo` (which round-trips the binary body so the
/// length-prefixed payload path is exercised before PR-012 needs it). PR-011
/// added the permission and window operations; PR-013 added the accessibility
/// ones.
///
/// `handle(frame:)` remains a function of its input and its injected services,
/// so the XCTest target exercises every branch — including the permission,
/// window and accessibility ones — without a window server, a TCC prompt, an
/// accessibility grant or a spawned process.
public final class HelperServer {
    public let helperVersion: String
    private let processIdentifier: Int
    private let startedAt: Date
    private let permissions: PermissionService
    private let windows: WindowService
    private let accessibility: AccessibilityService
    private var eventCounter = 0

    /// The services default to the live ones, so `main.swift` is unchanged and
    /// the PR-003 initialiser call still compiles. Each one added since is a
    /// defaulted parameter for the same reason.
    public init(
        helperVersion: String,
        processIdentifier: Int = Int(ProcessInfo.processInfo.processIdentifier),
        startedAt: Date = Date(),
        permissions: PermissionService = SystemPermissionService(),
        windows: WindowService = SystemWindowService(),
        accessibility: AccessibilityService = SystemAccessibilityService()
    ) {
        self.helperVersion = helperVersion
        self.processIdentifier = processIdentifier
        self.startedAt = startedAt
        self.permissions = permissions
        self.windows = windows
        self.accessibility = accessibility
    }

    private var uptimeMilliseconds: Int {
        max(0, Int(Date().timeIntervalSince(startedAt) * 1000))
    }

    /// The `helper.ready` event written once, before the first request.
    public func readyFrame() throws -> Frame {
        eventCounter += 1
        let message = HelperProtocol.eventMessage(
            id: "evt-\(eventCounter)",
            op: HelperProtocol.readyEventName,
            payload: [
                "helperVersion": helperVersion,
                "protocolVersion": HelperProtocol.version,
                "pid": processIdentifier,
            ]
        )
        let text = try HelperProtocol.encode(message)
        return Frame(messageText: text)
    }

    public func handle(frame: Frame) -> HelperOutcome {
        let request: HelperRequest
        do {
            request = try HelperProtocol.decodeRequest(frame.message)
        } catch let error as HelperMessageError {
            switch error {
            case .notARequest:
                // Responses and events flowing helper-ward are not part of the
                // PR-003 protocol; ignoring them keeps the stream aligned.
                return .ignore
            default:
                return .fatal("unreadable message: \(error)")
            }
        } catch {
            return .fatal("unreadable message")
        }

        guard let operation = HelperProtocol.Operation(rawValue: request.op) else {
            return failure(
                request: request,
                code: "invalid-request",
                domain: "ipc",
                message: "unknown operation \"\(request.op)\""
            )
        }

        switch operation {
        case .health:
            return success(
                request: request,
                payload: [
                    "status": "ok",
                    "helperVersion": helperVersion,
                    "protocolVersion": HelperProtocol.version,
                    "pid": processIdentifier,
                    "uptimeMs": uptimeMilliseconds,
                ]
            )
        case .echo:
            guard let text = request.payload["text"] as? String else {
                return failure(
                    request: request,
                    code: "invalid-request",
                    domain: "ipc",
                    message: "echo requires a text field"
                )
            }
            return success(
                request: request,
                payload: ["text": text, "binaryLength": frame.binary.count],
                binary: frame.binary
            )
        case .permissionsStatus:
            guard let kind = permissionKind(from: request) else {
                return invalidKind(request: request)
            }
            return success(request: request, payload: ["probe": permissions.probe(kind).jsonObject])
        case .permissionsSnapshot:
            return success(
                request: request,
                payload: ["probes": permissions.snapshot().map { $0.jsonObject }]
            )
        case .permissionsRequest:
            guard let kind = permissionKind(from: request) else {
                return invalidKind(request: request)
            }
            let outcome = permissions.request(kind)
            return success(
                request: request,
                payload: ["probe": outcome.probe.jsonObject, "prompted": outcome.prompted]
            )
        case .permissionsOpenSettings:
            guard let kind = permissionKind(from: request) else {
                return invalidKind(request: request)
            }
            let outcome = permissions.openSettings(kind)
            return success(
                request: request,
                payload: ["opened": outcome.opened, "target": outcome.target]
            )
        case .permissionsAttribution:
            guard let expected = request.payload["expected"] as? [String: Any],
                let hostPid = (expected["hostPid"] as? NSNumber)?.intValue
            else {
                return failure(
                    request: request,
                    code: "invalid-request",
                    domain: "ipc",
                    message: "permissions.attribution requires an expected.hostPid"
                )
            }
            let evidence = permissions.attribution(
                expectedBundleIdentifier: expected["bundleIdentifier"] as? String,
                expectedBundlePath: expected["bundlePath"] as? String,
                hostPid: hostPid
            )
            return success(request: request, payload: ["evidence": evidence.jsonObject])
        case .windowsList:
            let includeAllLayers = (request.payload["includeAllLayers"] as? Bool) ?? false
            return success(
                request: request,
                payload: windows.snapshot(includeAllLayers: includeAllLayers).jsonObject
            )
        case .windowsGet:
            guard let number = (request.payload["windowNumber"] as? NSNumber)?.intValue else {
                return failure(
                    request: request,
                    code: "invalid-request",
                    domain: "ipc",
                    message: "windows.get requires a windowNumber"
                )
            }
            let outcome = windows.window(number: number)
            return success(
                request: request,
                payload: [
                    "window": JSONValue.orNull(outcome.window?.jsonObject),
                    "display": JSONValue.orNull(outcome.display?.jsonObject),
                    "screenLocked": outcome.screenLocked,
                ]
            )
        case .accessibilitySample:
            let reading = accessibility.pointer()
            let trusted = accessibility.isTrusted()
            let includeElement = (request.payload["includeElement"] as? Bool) ?? false
            let lookup =
                includeElement
                ? accessibility.element(
                    at: reading.point,
                    ownerPid: (request.payload["ownerPid"] as? NSNumber)?.intValue,
                    includeValue: (request.payload["includeValue"] as? Bool) ?? false
                )
                : ElementLookup.notRequested
            var payload = reading.jsonFields
            payload["axTrusted"] = trusted
            for (key, value) in lookup.jsonFields {
                payload[key] = value
            }
            return success(request: request, payload: payload)
        case .accessibilityElementAt:
            guard let point = request.payload["point"] as? [String: Any],
                let x = RectRecord.numeric(point["x"]),
                let y = RectRecord.numeric(point["y"])
            else {
                return failure(
                    request: request,
                    code: "invalid-request",
                    domain: "ipc",
                    message: "accessibility.element-at requires a point"
                )
            }
            let lookup = accessibility.element(
                at: PointRecord(x: x, y: y),
                ownerPid: (request.payload["ownerPid"] as? NSNumber)?.intValue,
                includeValue: (request.payload["includeValue"] as? Bool) ?? false
            )
            var payload = lookup.jsonFields
            payload["axTrusted"] = accessibility.isTrusted()
            return success(request: request, payload: payload)
        }
    }

    private func permissionKind(from request: HelperRequest) -> PermissionKind? {
        guard let raw = request.payload["kind"] as? String else {
            return nil
        }
        return PermissionKind(rawValue: raw)
    }

    private func invalidKind(request: HelperRequest) -> HelperOutcome {
        failure(
            request: request,
            code: "invalid-request",
            domain: "ipc",
            message: "\"\(request.op)\" requires a known permission kind"
        )
    }

    private func success(
        request: HelperRequest,
        payload: [String: Any],
        binary: [UInt8] = []
    ) -> HelperOutcome {
        let message = HelperProtocol.successMessage(id: request.id, op: request.op, payload: payload)
        do {
            let text = try HelperProtocol.encode(message)
            return .reply(Frame(messageText: text, binary: binary))
        } catch {
            return .fatal("could not encode a response for \"\(request.op)\"")
        }
    }

    private func failure(
        request: HelperRequest,
        code: String,
        domain: String,
        message: String
    ) -> HelperOutcome {
        let body = HelperProtocol.failureMessage(
            id: request.id,
            op: request.op,
            code: code,
            domain: domain,
            message: message
        )
        do {
            let text = try HelperProtocol.encode(body)
            return .reply(Frame(messageText: text))
        } catch {
            return .fatal("could not encode an error for \"\(request.op)\"")
        }
    }
}

/// Blocking stdio loop. Kept out of `HelperServer` so the logic above stays
/// testable without file handles.
public enum HelperRuntime {
    public static let exitProtocolError: Int32 = 65
    public static let exitInternalError: Int32 = 70

    public static func run(
        server: HelperServer,
        input: FileHandle = FileHandle.standardInput,
        output: FileHandle = FileHandle.standardOutput,
        errorOutput: FileHandle = FileHandle.standardError,
        announceReady: Bool = true
    ) -> Int32 {
        let decoder = FrameDecoder()

        func write(_ frame: Frame) -> Bool {
            do {
                let bytes = try FrameCodec.encode(frame)
                output.write(Data(bytes))
                return true
            } catch {
                errorOutput.write(Data("pilot-helper: could not encode a frame\n".utf8))
                return false
            }
        }

        if announceReady {
            do {
                let ready = try server.readyFrame()
                if !write(ready) {
                    return exitInternalError
                }
            } catch {
                errorOutput.write(Data("pilot-helper: could not announce readiness\n".utf8))
                return exitInternalError
            }
        }

        while true {
            let data = input.availableData
            if data.isEmpty {
                return 0  // stdin closed: Pilot is shutting us down.
            }
            decoder.push([UInt8](data))

            while true {
                var frame: Frame?
                do {
                    frame = try decoder.next()
                } catch let error as FrameError {
                    errorOutput.write(Data("pilot-helper: \(error.message)\n".utf8))
                    return exitProtocolError
                } catch {
                    errorOutput.write(Data("pilot-helper: unreadable frame\n".utf8))
                    return exitProtocolError
                }

                guard let pending = frame else {
                    break
                }

                switch server.handle(frame: pending) {
                case .reply(let response):
                    if !write(response) {
                        return exitInternalError
                    }
                case .ignore:
                    continue
                case .fatal(let reason):
                    errorOutput.write(Data("pilot-helper: \(reason)\n".utf8))
                    return exitProtocolError
                }
            }
        }
    }
}
