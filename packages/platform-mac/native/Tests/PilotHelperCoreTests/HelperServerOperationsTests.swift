import Foundation
import XCTest

@testable import PilotHelperCore

/// Exercises the PR-011 operations through `HelperServer` with stub services,
/// so request decoding, dispatch and response encoding are covered without a
/// window server and without a TCC prompt.
final class HelperServerOperationsTests: XCTestCase {

    // MARK: - Stubs

    private final class StubPermissions: PermissionService {
        var states: [PermissionKind: PermissionState] = [:]
        var requested: [PermissionKind] = []
        var openedSettings: [PermissionKind] = []
        var settingsSucceed = true
        var evidence = AttributionEvidence(
            helperPid: 4321,
            parentPid: 1234,
            helperExecutablePath: "/Applications/Pilot.app/Contents/MacOS/PilotHelper",
            helperBundleIdentifier: nil,
            enclosingAppBundlePath: "/Applications/Pilot.app",
            enclosingAppBundleIdentifier: "com.pilot.app",
            responsibleProcessPid: 1234,
            responsibleProcessQueried: true,
            mainBundleIsApp: false
        )
        var attributionBundleIdentifiers: [String?] = []
        var attributionHostPids: [Int] = []

        func probe(_ kind: PermissionKind) -> PermissionProbe {
            let state = states[kind] ?? .unknown
            return PermissionProbe(
                kind: kind,
                state: state,
                canRequest: PermissionStateMapper.canRequest(state),
                api: .unavailable,
                raw: state.rawValue,
                restrictedRepresentable: true,
                requiresRelaunch: kind == .screenRecording
            )
        }

        func request(_ kind: PermissionKind) -> (probe: PermissionProbe, prompted: Bool) {
            requested.append(kind)
            let before = probe(kind)
            if !before.canRequest {
                return (before, false)
            }
            states[kind] = .granted
            return (probe(kind), true)
        }

        func openSettings(_ kind: PermissionKind) -> (opened: Bool, target: String) {
            openedSettings.append(kind)
            return (settingsSucceed, PermissionSettingsTarget.url(for: kind))
        }

        func attribution(
            expectedBundleIdentifier: String?,
            expectedBundlePath: String?,
            hostPid: Int
        ) -> AttributionEvidence {
            attributionBundleIdentifiers.append(expectedBundleIdentifier)
            attributionHostPids.append(hostPid)
            return evidence
        }
    }

    private final class StubWindows: WindowService {
        var snapshotData = WindowSnapshotData(
            windows: [],
            displays: [],
            screenLocked: false,
            capturedAt: 1_700_000_000_000
        )
        var lookup: [Int: WindowRecord] = [:]
        var includeAllLayersCalls: [Bool] = []

        func snapshot(includeAllLayers: Bool) -> WindowSnapshotData {
            includeAllLayersCalls.append(includeAllLayers)
            return snapshotData
        }

        func window(
            number: Int
        ) -> (window: WindowRecord?, display: DisplayRecord?, screenLocked: Bool) {
            return (lookup[number], nil, false)
        }
    }

    // MARK: - Helpers

    private func makeServer(
        permissions: StubPermissions = StubPermissions(),
        windows: StubWindows = StubWindows()
    ) -> HelperServer {
        return HelperServer(
            helperVersion: "0.1.0",
            processIdentifier: 4321,
            permissions: permissions,
            windows: windows
        )
    }

    /// Sends one request and returns the decoded response body.
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
        guard let dictionary = object as? [String: Any] else {
            XCTFail("expected a JSON object")
            return [:]
        }
        return dictionary
    }

    private func payload(_ response: [String: Any]) throws -> [String: Any] {
        return try XCTUnwrap(response["payload"] as? [String: Any])
    }

    // MARK: - Permissions

    func testStatusReturnsTheProbeForTheRequestedKind() throws {
        let permissions = StubPermissions()
        permissions.states[.microphone] = .restricted
        let server = makeServer(permissions: permissions)

        let response = try answer(
            server, id: "r1", op: "permissions.status", payload: ["kind": "microphone"])
        XCTAssertEqual(response["ok"] as? Bool, true)

        let probe = try payload(response)["probe"] as? [String: Any]
        XCTAssertEqual(probe?["kind"] as? String, "microphone")
        XCTAssertEqual(probe?["state"] as? String, "restricted")
        XCTAssertEqual(probe?["canRequest"] as? Bool, false)
    }

    func testSnapshotReturnsEveryPermissionKind() throws {
        let permissions = StubPermissions()
        permissions.states = [
            .screenRecording: .granted,
            .accessibility: .denied,
            .microphone: .restricted,
            .speechRecognition: .unknown,
        ]
        let server = makeServer(permissions: permissions)

        let response = try answer(server, id: "r2", op: "permissions.snapshot")
        let probes = try XCTUnwrap(try payload(response)["probes"] as? [[String: Any]])
        XCTAssertEqual(probes.count, PermissionKind.allCases.count)

        var byKind: [String: String] = [:]
        for probe in probes {
            let kind = probe["kind"] as? String ?? ""
            byKind[kind] = probe["state"] as? String ?? ""
        }
        XCTAssertEqual(byKind["screen-recording"], "granted")
        XCTAssertEqual(byKind["accessibility"], "denied")
        XCTAssertEqual(byKind["microphone"], "restricted")
        XCTAssertEqual(byKind["speech-recognition"], "unknown")
    }

    func testUnknownPermissionKindIsATypedFailure() throws {
        let server = makeServer()
        let response = try answer(
            server, id: "r3", op: "permissions.status", payload: ["kind": "camera"])

        XCTAssertEqual(response["ok"] as? Bool, false)
        XCTAssertEqual((response["error"] as? [String: Any])?["code"] as? String, "invalid-request")
    }

    func testRequestReportsWhetherAPromptWasRaised() throws {
        let permissions = StubPermissions()
        permissions.states[.microphone] = .unknown
        let server = makeServer(permissions: permissions)

        let first = try answer(
            server, id: "r4", op: "permissions.request", payload: ["kind": "microphone"])
        XCTAssertEqual(try payload(first)["prompted"] as? Bool, true)

        // Already granted: macOS has nothing left to ask.
        let second = try answer(
            server, id: "r5", op: "permissions.request", payload: ["kind": "microphone"])
        XCTAssertEqual(try payload(second)["prompted"] as? Bool, false)
    }

    func testOpenSettingsReportsTheTargetItTried() throws {
        let permissions = StubPermissions()
        permissions.settingsSucceed = false
        let server = makeServer(permissions: permissions)

        let response = try answer(
            server, id: "r6", op: "permissions.open-settings",
            payload: ["kind": "screen-recording"])
        let body = try payload(response)

        XCTAssertEqual(body["opened"] as? Bool, false)
        XCTAssertEqual(
            body["target"] as? String, PermissionSettingsTarget.url(for: .screenRecording))
    }

    func testAttributionPassesTheHostSuppliedExpectationThrough() throws {
        let permissions = StubPermissions()
        let server = makeServer(permissions: permissions)

        let expected: [String: Any] = [
            "bundleIdentifier": "com.pilot.app",
            "bundlePath": "/Applications/Pilot.app",
            "hostPid": 1234,
        ]
        let response = try answer(
            server, id: "r7", op: "permissions.attribution", payload: ["expected": expected])

        XCTAssertEqual(response["ok"] as? Bool, true)
        XCTAssertEqual(permissions.attributionBundleIdentifiers, ["com.pilot.app"])
        XCTAssertEqual(permissions.attributionHostPids, [1234])

        let evidence = try payload(response)["evidence"] as? [String: Any]
        XCTAssertEqual(evidence?["responsibleProcessPid"] as? Int, 1234)
        XCTAssertEqual(evidence?["responsibleProcessQueried"] as? Bool, true)
    }

    func testAttributionWithoutAHostPidIsATypedFailure() throws {
        let server = makeServer()
        let response = try answer(server, id: "r8", op: "permissions.attribution")

        XCTAssertEqual(response["ok"] as? Bool, false)
        XCTAssertEqual((response["error"] as? [String: Any])?["code"] as? String, "invalid-request")
    }

    // MARK: - Windows

    func testWindowListReturnsTheSnapshot() throws {
        let windows = StubWindows()
        let display = DisplayRecord(
            displayNumber: 1,
            bounds: RectRecord(x: 0, y: 0, width: 1728, height: 1117),
            scaleFactor: 2,
            isPrimary: true
        )
        let record = WindowRecord(
            windowNumber: 42,
            ownerPid: 501,
            applicationName: "Safari",
            applicationBundleId: "com.apple.Safari",
            title: "Billing Settings",
            titleAvailable: true,
            bounds: RectRecord(x: 100, y: 80, width: 1200, height: 800),
            displayNumber: 1,
            isOnScreen: true,
            layer: 0
        )
        windows.snapshotData = WindowSnapshotData(
            windows: [record],
            displays: [display],
            screenLocked: true,
            capturedAt: 1_700_000_000_000
        )
        let server = makeServer(windows: windows)

        let body = try payload(try answer(server, id: "r9", op: "windows.list"))
        XCTAssertEqual(body["screenLocked"] as? Bool, true)
        XCTAssertEqual(body["titlesWithheld"] as? Bool, false)
        XCTAssertEqual((body["windows"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual((body["displays"] as? [[String: Any]])?.count, 1)
        XCTAssertEqual(windows.includeAllLayersCalls, [false])
    }

    func testWindowListHonoursIncludeAllLayers() throws {
        let windows = StubWindows()
        let server = makeServer(windows: windows)
        _ = try answer(
            server, id: "r10", op: "windows.list", payload: ["includeAllLayers": true])
        XCTAssertEqual(windows.includeAllLayersCalls, [true])
    }

    func testWindowGetReturnsNullForAWindowThatIsGone() throws {
        let server = makeServer()
        let response = try answer(
            server, id: "r11", op: "windows.get", payload: ["windowNumber": 99])
        XCTAssertEqual(response["ok"] as? Bool, true)

        let body = try payload(response)
        XCTAssertTrue(body["window"] is NSNull)
        XCTAssertTrue(body["display"] is NSNull)
    }

    func testWindowGetReturnsAKnownWindow() throws {
        let windows = StubWindows()
        windows.lookup[42] = WindowRecord(
            windowNumber: 42,
            ownerPid: 501,
            applicationName: "Safari",
            applicationBundleId: "com.apple.Safari",
            title: "Billing Settings",
            titleAvailable: true,
            bounds: RectRecord(x: 100, y: 80, width: 1200, height: 800),
            displayNumber: 1,
            isOnScreen: true,
            layer: 0
        )
        let server = makeServer(windows: windows)

        let body = try payload(
            try answer(server, id: "r13", op: "windows.get", payload: ["windowNumber": 42]))
        let window = try XCTUnwrap(body["window"] as? [String: Any])
        XCTAssertEqual(window["windowNumber"] as? Int, 42)
        XCTAssertEqual(window["title"] as? String, "Billing Settings")
    }

    func testWindowGetWithoutAWindowNumberIsATypedFailure() throws {
        let server = makeServer()
        let response = try answer(server, id: "r12", op: "windows.get")

        XCTAssertEqual(response["ok"] as? Bool, false)
        XCTAssertEqual((response["error"] as? [String: Any])?["code"] as? String, "invalid-request")
    }

    // MARK: - Registry

    func testEveryOperationNameMatchesTheHostNamingRule() {
        // `^[a-z][a-z0-9]*([.-][a-z0-9]+)*$`, enforced by the host's message
        // schema. An operation the host will not accept is unreachable.
        let pattern = "^[a-z][a-z0-9]*([.-][a-z0-9]+)*$"
        let operations: [HelperProtocol.Operation] = [
            .health,
            .echo,
            .permissionsStatus,
            .permissionsSnapshot,
            .permissionsRequest,
            .permissionsOpenSettings,
            .permissionsAttribution,
            .windowsList,
            .windowsGet,
        ]

        for operation in operations {
            let name = operation.rawValue
            XCTAssertNotNil(
                name.range(of: pattern, options: .regularExpression),
                "operation name \"\(name)\" is not one the host will accept"
            )
            XCTAssertLessThanOrEqual(name.count, 64)
        }
    }

    func testTheProtocolVersionIsUnchangedByAddingOperations() {
        // Appending operations is backwards compatible in both directions.
        // Bumping this would strand every helper built for PR-003.
        XCTAssertEqual(HelperProtocol.version, 1)
        XCTAssertEqual(Int(FrameConstants.protocolVersion), HelperProtocol.version)
    }
}
