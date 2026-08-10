import Foundation

/// Permission vocabulary and the state mapping, with **no framework imports**.
///
/// Everything here is a pure function of its arguments, which is the point:
/// it is the part of PR-011's Swift that `swift test` can actually prove
/// correct. The calls that touch TCC live in `PermissionProbes.swift`, behind
/// the `PermissionService` protocol, so they can be substituted in tests.
///
/// Mirrors `packages/platform-mac/src/protocol/permission-ops.ts`.

public enum PermissionKind: String, CaseIterable {
    case screenRecording = "screen-recording"
    case accessibility = "accessibility"
    case microphone = "microphone"
    case speechRecognition = "speech-recognition"
}

public enum PermissionState: String {
    case unknown
    case denied
    case restricted
    case granted
}

/// Which macOS API answered a probe.
public enum PermissionProbeAPI: String {
    case cgPreflight = "cg-preflight"
    case axTrusted = "ax-trusted"
    case avAuthorization = "av-authorization"
    case sfAuthorization = "sf-authorization"
    case unavailable = "unavailable"
}

public struct PermissionProbe {
    public let kind: PermissionKind
    public let state: PermissionState
    public let canRequest: Bool
    public let api: PermissionProbeAPI
    public let raw: String
    public let restrictedRepresentable: Bool
    public let requiresRelaunch: Bool

    public init(
        kind: PermissionKind,
        state: PermissionState,
        canRequest: Bool,
        api: PermissionProbeAPI,
        raw: String,
        restrictedRepresentable: Bool,
        requiresRelaunch: Bool
    ) {
        self.kind = kind
        self.state = state
        self.canRequest = canRequest
        self.api = api
        self.raw = raw
        self.restrictedRepresentable = restrictedRepresentable
        self.requiresRelaunch = requiresRelaunch
    }

    public var jsonObject: [String: Any] {
        [
            "kind": kind.rawValue,
            "state": state.rawValue,
            "canRequest": canRequest,
            "api": api.rawValue,
            "raw": raw,
            "restrictedRepresentable": restrictedRepresentable,
            "requiresRelaunch": requiresRelaunch,
        ]
    }
}

/// The four domain states, derived from four differently shaped macOS APIs.
///
/// The two authorization enums do **not** agree on their raw values, which is
/// exactly the sort of thing that silently turns `restricted` into `denied`:
///
///     AVAuthorizationStatus            SFSpeechRecognizerAuthorizationStatus
///     0 notDetermined                  0 notDetermined
///     1 restricted                     1 denied
///     2 denied                         2 restricted
///     3 authorized                     3 authorized
///
/// So they get one mapper each, and both are covered by tests.
public enum PermissionStateMapper {
    /// `AVAuthorizationStatus.rawValue` → domain state.
    public static func fromCaptureAuthorization(_ rawValue: Int) -> PermissionState {
        switch rawValue {
        case 0: return .unknown
        case 1: return .restricted
        case 2: return .denied
        case 3: return .granted
        default: return .unknown
        }
    }

    /// `SFSpeechRecognizerAuthorizationStatus.rawValue` → domain state.
    public static func fromSpeechAuthorization(_ rawValue: Int) -> PermissionState {
        switch rawValue {
        case 0: return .unknown
        case 1: return .denied
        case 2: return .restricted
        case 3: return .granted
        default: return .unknown
        }
    }

    /// Boolean APIs (`CGPreflightScreenCaptureAccess`, `AXIsProcessTrusted`).
    ///
    /// A `false` from these means "not granted" and nothing more: macOS offers
    /// no way to ask whether the user has ever been prompted, and no way to
    /// express `restricted` at all. Reporting `denied` for it would claim
    /// knowledge that does not exist, and would send a first-run user to
    /// System Settings instead of showing them the prompt that would have
    /// worked.
    ///
    /// So `false` is `unknown` until this process has actually raised the
    /// prompt and still been refused, which is the one moment the distinction
    /// becomes observable.
    public static func fromBoolean(granted: Bool, promptRaised: Bool) -> PermissionState {
        if granted {
            return .granted
        }
        return promptRaised ? .denied : .unknown
    }

    /// Whether an in-app prompt can still achieve anything.
    ///
    /// Only `unknown` qualifies. `restricted` is policy and no prompt overrides
    /// it; `denied` means macOS will not show the prompt a second time; and
    /// `granted` has nothing to ask for.
    public static func canRequest(_ state: PermissionState) -> Bool {
        state == .unknown
    }
}

/// System Settings destinations, one per permission.
///
/// `x-apple.systempreferences:` with an anchor lands on the correct row rather
/// than the top of Privacy & Security, which matters because the user is being
/// sent there precisely when the in-app prompt cannot help them.
public enum PermissionSettingsTarget {
    public static func url(for kind: PermissionKind) -> String {
        let base = "x-apple.systempreferences:com.apple.preference.security?"
        switch kind {
        case .screenRecording:
            return base + "Privacy_ScreenCapture"
        case .accessibility:
            return base + "Privacy_Accessibility"
        case .microphone:
            return base + "Privacy_Microphone"
        case .speechRecognition:
            return base + "Privacy_SpeechRecognition"
        }
    }
}
