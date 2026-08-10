import AVFoundation
import ApplicationServices
import CoreGraphics
import Darwin
import Foundation
import Speech

/// The TCC-touching half of permissions.
///
/// **None of this file has ever been compiled or run** (runbook amendment 8).
/// It is written to be conservative rather than clever: no concurrency, no
/// generics, no availability gymnastics, one framework call per function, and
/// every failure degrading to a value rather than a trap. Anything that could
/// be expressed as pure logic was moved to `PermissionModel.swift` and
/// `Attribution.swift`, which the XCTest target does cover.
///
/// The protocol exists so `HelperServer` can be driven by a stub in tests.

public protocol PermissionService {
    func probe(_ kind: PermissionKind) -> PermissionProbe
    func request(_ kind: PermissionKind) -> (probe: PermissionProbe, prompted: Bool)
    func openSettings(_ kind: PermissionKind) -> (opened: Bool, target: String)
    func attribution(
        expectedBundleIdentifier: String?,
        expectedBundlePath: String?,
        hostPid: Int
    ) -> AttributionEvidence
}

extension PermissionService {
    public func snapshot() -> [PermissionProbe] {
        PermissionKind.allCases.map { probe($0) }
    }
}

/// Looks up the process macOS holds responsible for another process.
///
/// This is the single most valuable fact in the whole attribution check: the
/// responsible process *is* the identity TCC attributes grants to. It is also
/// SPI — `responsibility_get_pid_responsible_for_pid` is exported by
/// `libsystem_secinit`/`libquarantine` but is not in any public header.
///
/// So it is resolved by name at run time and every failure returns `nil`. A
/// missing symbol must not crash the helper and must not be reported as a
/// wrong answer; it downgrades the host's verdict from `direct` to `inferred`,
/// which is exactly the honest outcome.
public enum ProcessResponsibility {
    private typealias ResponsibleForPID = @convention(c) (pid_t) -> pid_t

    /// `nil` when the symbol is unavailable or the call failed.
    public static func responsiblePid(for pid: Int) -> Int? {
        guard let handle = dlopen(nil, RTLD_NOW) else {
            return nil
        }
        defer { dlclose(handle) }
        guard let symbol = dlsym(handle, "responsibility_get_pid_responsible_for_pid") else {
            return nil
        }
        let function = unsafeBitCast(symbol, to: ResponsibleForPID.self)
        let result = function(pid_t(pid))
        if result < 0 {
            return nil
        }
        return Int(result)
    }
}

/// Live TCC probes.
public final class SystemPermissionService: PermissionService {
    /// Permissions this process has actually raised a prompt for.
    ///
    /// Needed by the boolean APIs: `CGPreflightScreenCaptureAccess` returning
    /// `false` means "not granted", and only the fact that we already asked
    /// turns that into `denied` rather than `unknown`. Held per process, so a
    /// helper restart resets it to `unknown` — the conservative direction, and
    /// the one that keeps offering the prompt instead of falsely reporting a
    /// refusal.
    private var promptRaised = Set<PermissionKind>()

    public init() {}

    // MARK: - Probes

    public func probe(_ kind: PermissionKind) -> PermissionProbe {
        switch kind {
        case .screenRecording:
            return screenRecordingProbe()
        case .accessibility:
            return accessibilityProbe()
        case .microphone:
            return microphoneProbe()
        case .speechRecognition:
            return speechProbe()
        }
    }

    private func screenRecordingProbe() -> PermissionProbe {
        let granted = CGPreflightScreenCaptureAccess()
        let state = PermissionStateMapper.fromBoolean(
            granted: granted,
            promptRaised: promptRaised.contains(.screenRecording)
        )
        return PermissionProbe(
            kind: .screenRecording,
            state: state,
            canRequest: PermissionStateMapper.canRequest(state),
            api: .cgPreflight,
            raw: granted ? "true" : "false",
            restrictedRepresentable: false,
            // macOS keeps handing the old answer to an already-running process
            // after the user grants Screen Recording. Nothing short of a
            // relaunch changes it, and pretending otherwise strands the user
            // toggling a switch that appears to do nothing.
            requiresRelaunch: true
        )
    }

    private func accessibilityProbe() -> PermissionProbe {
        let trusted = AXIsProcessTrusted()
        let state = PermissionStateMapper.fromBoolean(
            granted: trusted,
            promptRaised: promptRaised.contains(.accessibility)
        )
        return PermissionProbe(
            kind: .accessibility,
            state: state,
            canRequest: PermissionStateMapper.canRequest(state),
            api: .axTrusted,
            raw: trusted ? "true" : "false",
            restrictedRepresentable: false,
            requiresRelaunch: false
        )
    }

    private func microphoneProbe() -> PermissionProbe {
        let raw = AVCaptureDevice.authorizationStatus(for: .audio).rawValue
        let state = PermissionStateMapper.fromCaptureAuthorization(Int(raw))
        return PermissionProbe(
            kind: .microphone,
            state: state,
            canRequest: PermissionStateMapper.canRequest(state),
            api: .avAuthorization,
            raw: String(raw),
            restrictedRepresentable: true,
            requiresRelaunch: false
        )
    }

    private func speechProbe() -> PermissionProbe {
        let raw = SFSpeechRecognizer.authorizationStatus().rawValue
        let state = PermissionStateMapper.fromSpeechAuthorization(Int(raw))
        return PermissionProbe(
            kind: .speechRecognition,
            state: state,
            canRequest: PermissionStateMapper.canRequest(state),
            api: .sfAuthorization,
            raw: String(raw),
            restrictedRepresentable: true,
            requiresRelaunch: false
        )
    }

    // MARK: - Requests

    /// Raises a prompt and returns immediately.
    ///
    /// It does **not** wait for the user. The stdio loop is single-threaded;
    /// blocking it on a dialog the user may leave open for minutes would stall
    /// `health` and every other operation, and the supervisor would eventually
    /// declare the helper dead and kill it mid-prompt. The host observes the
    /// outcome through its normal polling instead.
    ///
    /// ## Info.plist hazard — read before running this on a Mac
    ///
    /// macOS **kills** a process that requests Microphone or Speech
    /// Recognition without the matching usage string in the responsible
    /// process's `Info.plist`:
    ///
    /// - `NSMicrophoneUsageDescription`
    /// - `NSSpeechRecognitionUsageDescription`
    ///
    /// The helper is a bare executable with no `Info.plist` of its own, so it
    /// survives this only if macOS is attributing it to the parent app bundle
    /// — which is precisely the question `permissions.attribution` exists to
    /// answer. That makes the crash a *useful* signal rather than only a bug:
    ///
    /// > If requesting Microphone or Speech Recognition kills the helper, TCC
    /// > is reading the helper's own (non-existent) `Info.plist`, and
    /// > attribution is wrong regardless of what the verdict says.
    ///
    /// It degrades safely: PR-003's supervisor sees the exit, rejects the
    /// in-flight request with `helper-unavailable`, files a crash report and
    /// restarts. Nothing hangs. But the two keys must exist in the packaged
    /// app's `Info.plist` (PR-042) before this path is exercised in anger.
    public func request(_ kind: PermissionKind) -> (probe: PermissionProbe, prompted: Bool) {
        let before = probe(kind)
        guard before.canRequest else {
            return (before, false)
        }
        promptRaised.insert(kind)

        switch kind {
        case .screenRecording:
            _ = CGRequestScreenCaptureAccess()
        case .accessibility:
            let key = kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String
            let options: CFDictionary = [key: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        case .microphone:
            AVCaptureDevice.requestAccess(for: .audio) { _ in }
        case .speechRecognition:
            SFSpeechRecognizer.requestAuthorization { _ in }
        }

        return (probe(kind), true)
    }

    public func openSettings(_ kind: PermissionKind) -> (opened: Bool, target: String) {
        let target = PermissionSettingsTarget.url(for: kind)
        // `/usr/bin/open` rather than `NSWorkspace`: the helper is a plain
        // executable with no Info.plist, and shelling out avoids depending on
        // AppKit behaving itself in a process that is not an application.
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
        process.arguments = [target]
        do {
            try process.run()
            return (true, target)
        } catch {
            return (false, target)
        }
    }

    // MARK: - Attribution

    /// Reports observable facts only.
    ///
    /// The three `expected*` parameters are deliberately unused: the helper
    /// does not compare, and does not get to decide. The verdict is computed
    /// on the host, where it can be tested. They stay in the signature so the
    /// wire request documents what the host is checking against, and so a
    /// future implementation that genuinely needs them does not change the
    /// protocol.
    public func attribution(
        expectedBundleIdentifier: String?,
        expectedBundlePath: String?,
        hostPid: Int
    ) -> AttributionEvidence {
        let helperPid = Int(ProcessInfo.processInfo.processIdentifier)
        let executablePath = Bundle.main.executablePath
        let enclosing = executablePath.flatMap { BundlePath.enclosingAppBundle(of: $0) }
        let enclosingIdentifier = enclosing.flatMap { Bundle(path: $0)?.bundleIdentifier }
        let responsible = ProcessResponsibility.responsiblePid(for: helperPid)

        return AttributionEvidence(
            helperPid: helperPid,
            parentPid: Int(getppid()),
            helperExecutablePath: executablePath,
            helperBundleIdentifier: Bundle.main.bundleIdentifier,
            enclosingAppBundlePath: enclosing,
            enclosingAppBundleIdentifier: enclosingIdentifier,
            responsibleProcessPid: responsible,
            responsibleProcessQueried: responsible != nil,
            mainBundleIsApp: BundlePath.isAppBundle(Bundle.main.bundlePath)
        )
    }
}
