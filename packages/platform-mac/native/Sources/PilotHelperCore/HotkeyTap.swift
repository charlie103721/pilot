import ApplicationServices
import CoreGraphics
import Dispatch
import Foundation

/// The `CGEventTap` half of global push-to-talk (PR-015).
///
/// **None of this file has ever been compiled or run** (runbook amendment 8).
/// Like `PermissionProbes.swift` it is written to be conservative rather than
/// clever: no async/await, no actors, no generics, one framework call per step,
/// and every failure degrading to a reported state instead of a trap. All the
/// logic that could be pure was moved into `HotkeyModel.swift`, which the
/// XCTest target does cover.
///
/// ## Why a tap at all
///
/// `docs/mvp-01-point-ask-hear.md` requires "push-to-talk shortcut works while
/// Pilot is not focused". Nothing short of a `CGEventTap` (or a registered
/// global hotkey, which cannot report key-*up* and so cannot express "held")
/// hears a key when another application owns the keyboard. That is also why it
/// needs Accessibility, and why it is worth being careful.
///
/// ## Why this is not a keylogger
///
/// A keyboard tap is handed every keystroke on the session, so the guarantee
/// cannot be "it does not see them" — it has to be "nothing survives the
/// comparison". Six properties, each independently checkable:
///
/// 1. **`.listenOnly`.** The tap is created without the right to modify or
///    swallow events. Even a bug cannot alter what the user typed.
/// 2. **One comparison, then return.** `handle(type:event:)` reads exactly one
///    integer from a non-matching event — its virtual key code — compares it,
///    and returns. That value is not stored, not copied, not logged, not
///    counted per-key and not transmitted. Nothing else about the event is
///    read: not `flags`, not the autorepeat field, not any unicode payload.
/// 3. **No buffer.** The service holds a `Bool` (held), a sequence number and
///    five counters. There is no queue, ring, array or file that a keystroke
///    could accumulate in.
/// 4. **A narrow wire shape.** The only thing that leaves this process is
///    `HotkeyKeyReport`: a phase, the configured key code, a millisecond
///    timestamp, a sequence number and a repeat flag. The host validates it
///    against a `strictObject` schema, so a payload carrying anything else
///    fails validation instead of being read.
/// 5. **Nothing on stderr.** The callback never writes a diagnostic. Helper
///    stderr is captured into crash reports, which would be a lovely place to
///    accidentally keep a transcript of somebody's password.
/// 6. **A mask that is as narrow as the API allows.** `CGEventMask` selects
///    event *types*, not key codes; there is no way to ask macOS for one key.
///    The mask therefore covers `keyDown`, `keyUp` and `flagsChanged` and the
///    narrowing happens in property 2. Mouse, scroll and every other event
///    class are excluded outright.

/// The service `HelperServer` talks to. A protocol so the XCTest target can
/// drive the operations with a stub and never create a real tap.
public protocol HotkeyService: AnyObject {
    /// Set once, before `start`, by whoever owns event delivery.
    var onKey: ((HotkeyKeyReport) -> Void)? { get set }
    var onTapChange: ((HotkeyTapChange, HotkeyStatus) -> Void)? { get set }

    /// Installs or replaces the tap. Never throws and never blocks on a user:
    /// a missing permission comes back as a status.
    func start(binding: HotkeyBinding) -> HotkeyStatus
    func stop() -> HotkeyStatus
    func status() -> HotkeyStatus
}

/// C entry point for the tap. Free function, no captures, so it converts to
/// `CGEventTapCallBack`.
private func pilotHotkeyTapCallback(
    proxy: CGEventTapProxy,
    type: CGEventType,
    event: CGEvent,
    userInfo: UnsafeMutableRawPointer?
) -> Unmanaged<CGEvent>? {
    _ = proxy
    if let userInfo = userInfo {
        let service = Unmanaged<SystemHotkeyService>.fromOpaque(userInfo).takeUnretainedValue()
        service.handle(type: type, event: event)
    }
    // Always pass the event through unchanged. The tap is `.listenOnly`, so
    // this return value cannot alter delivery, but returning the event
    // unmodified is the contract and keeps that true if the options ever change.
    return Unmanaged.passUnretained(event)
}

public final class SystemHotkeyService: HotkeyService {
    public var onKey: ((HotkeyKeyReport) -> Void)?
    public var onTapChange: ((HotkeyTapChange, HotkeyStatus) -> Void)?

    /// Guards everything below. Held only across state reads and writes —
    /// never across a callback into `onKey` / `onTapChange`, because those
    /// write a frame and a lock held across I/O is a deadlock waiting for a
    /// slow pipe.
    private let lock = NSLock()

    private let gate = HotkeyGate()
    private var tap: CFMachPort?
    private var runLoopSource: CFRunLoopSource?
    private var tapRunLoop: CFRunLoop?
    private var runLoopReady = DispatchSemaphore(value: 0)
    private var tapState: HotkeyTapState = .stopped
    private var detail = ""
    private var counters = HotkeyCounters()
    private var budget = HotkeyRecoveryBudget()
    private var sequence = 0

    public init() {}

    // MARK: - Service

    public func start(binding: HotkeyBinding) -> HotkeyStatus {
        teardown()

        lock.lock()
        gate.rebind(binding)
        budget = HotkeyRecoveryBudget()
        lock.unlock()

        // `AXIsProcessTrusted()` is the same probe PR-011 reports as the
        // `accessibility` permission, so a denial here is a state the user can
        // already see and act on rather than a new failure mode.
        guard AXIsProcessTrusted() else {
            return finish(
                state: .accessibilityDenied,
                detail: "AXIsProcessTrusted() is false; grant Accessibility to Pilot",
                change: .failed
            )
        }

        let mask: CGEventMask =
            (1 << CGEventType.keyDown.rawValue)
            | (1 << CGEventType.keyUp.rawValue)
            | (1 << CGEventType.flagsChanged.rawValue)

        let created = CGEvent.tapCreate(
            tap: .cgSessionEventTap,
            place: .tailAppendEventTap,
            options: .listenOnly,
            eventsOfInterest: mask,
            callback: pilotHotkeyTapCallback,
            userInfo: Unmanaged.passUnretained(self).toOpaque()
        )

        guard let created = created else {
            // Accessibility is granted and macOS still refused. On macOS 10.15+
            // this is most often Input Monitoring — a separate TCC service that
            // Pilot does not model. Say so in the detail rather than reporting
            // a permission problem Pilot cannot name.
            return finish(
                state: .creationFailed,
                detail:
                    "CGEventTapCreate returned null although Accessibility is granted; "
                    + "check Privacy & Security > Input Monitoring",
                change: .failed
            )
        }

        guard let source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, created, 0) else {
            CFMachPortInvalidate(created)
            return finish(
                state: .creationFailed,
                detail: "CFMachPortCreateRunLoopSource returned null",
                change: .failed
            )
        }

        lock.lock()
        tap = created
        runLoopSource = source
        runLoopReady = DispatchSemaphore(value: 0)
        lock.unlock()

        // The tap must not run on the stdio thread. That thread blocks in
        // `FileHandle.availableData` waiting for the next request, so a tap
        // installed on it would never fire; and if it somehow did, the callback
        // would be running inside the request loop, where overrunning macOS's
        // callback deadline is exactly what gets a tap disabled by timeout.
        let thread = Thread { [weak self] in
            guard let self = self else {
                return
            }
            self.runTapLoop(source: source, tap: created)
        }
        thread.name = "com.pilot.hotkey-tap"
        thread.stackSize = 512 * 1024
        thread.start()

        return finish(state: .active, detail: "", change: .started)
    }

    public func stop() -> HotkeyStatus {
        teardown()
        return finish(state: .stopped, detail: "", change: .stopped)
    }

    public func status() -> HotkeyStatus {
        let trusted = AXIsProcessTrusted()
        lock.lock()
        defer { lock.unlock() }
        return statusLocked(accessibilityTrusted: trusted)
    }

    // MARK: - Tap thread

    private func runTapLoop(source: CFRunLoopSource, tap: CFMachPort) {
        let loop = CFRunLoopGetCurrent()
        lock.lock()
        tapRunLoop = loop
        lock.unlock()
        runLoopReady.signal()

        CFRunLoopAddSource(loop, source, CFRunLoopMode.commonModes)
        CGEvent.tapEnable(tap: tap, enable: true)
        CFRunLoopRun()

        // Reached when the source is invalidated or the loop is stopped.
        CFRunLoopRemoveSource(loop, source, CFRunLoopMode.commonModes)
        lock.lock()
        if tapRunLoop === loop {
            tapRunLoop = nil
        }
        lock.unlock()
    }

    /// Called on the tap thread for every keyboard event on the session.
    ///
    /// Read property 2 in this file's header before changing anything here.
    func handle(type: CGEventType, event: CGEvent) {
        if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
            handleDisabled(byTimeout: type == .tapDisabledByTimeout)
            return
        }

        let kind: HotkeyEventKind
        switch type {
        case .keyDown: kind = .keyDown
        case .keyUp: kind = .keyUp
        case .flagsChanged: kind = .flagsChanged
        default: return
        }

        let keyCode = Int(event.getIntegerValueField(.keyboardEventKeycode))

        lock.lock()
        // The comparison, and the point past which a foreign key does not
        // exist. `gate.decide` returns `.otherKey` before reading anything
        // else; the early exit here means we do not even read `flags` for a
        // key that is not ours.
        guard keyCode == gate.binding.keyCode else {
            lock.unlock()
            return
        }

        let autorepeat = event.getIntegerValueField(.keyboardEventAutorepeat) != 0
        let input = HotkeyRawInput(
            keyCode: keyCode,
            kind: kind,
            flags: event.flags.rawValue,
            autorepeat: autorepeat
        )
        let decision = gate.decide(input)
        counters.emitted = gate.emitted
        counters.suppressed = gate.suppressed

        var report: HotkeyKeyReport?
        if case .emit(let phase) = decision {
            sequence += 1
            report = HotkeyKeyReport(
                phase: phase,
                keyCode: keyCode,
                at: HelperProtocol.now(),
                sequence: sequence,
                autorepeat: autorepeat
            )
        }
        lock.unlock()

        if let report = report {
            onKey?(report)
        }
    }

    private func handleDisabled(byTimeout: Bool) {
        lock.lock()
        if byTimeout {
            counters.disabledByTimeout += 1
        } else {
            counters.disabledByUserInput += 1
        }
        // Whatever was held is no longer knowable: transitions arriving while
        // the tap was off were never delivered. Forget it here and let the host
        // synthesise the release, which is the layer that can prove the
        // consumer heard it.
        gate.forgetHeld()
        let allowed = budget.allow(now: Date().timeIntervalSince1970)
        let currentTap = tap
        let disabledStatus = statusLocked(
            accessibilityTrusted: true,
            overrideState: .disabled,
            overrideDetail: byTimeout
                ? "macOS disabled the tap: callback deadline exceeded"
                : "macOS disabled the tap: user-input taps were switched off"
        )
        lock.unlock()

        onTapChange?(byTimeout ? .disabledByTimeout : .disabledByUserInput, disabledStatus)

        guard allowed, let currentTap = currentTap else {
            lock.lock()
            tapState = .disabled
            detail =
                "the event tap was disabled by the system more than "
                + "\(budget.maxRestores) times in \(Int(budget.windowSeconds))s"
            let failedStatus = statusLocked(accessibilityTrusted: true)
            lock.unlock()
            onTapChange?(.failed, failedStatus)
            return
        }

        CGEvent.tapEnable(tap: currentTap, enable: true)

        lock.lock()
        counters.reEnabled += 1
        tapState = .active
        detail = ""
        let restoredStatus = statusLocked(accessibilityTrusted: true)
        lock.unlock()
        onTapChange?(.reEnabled, restoredStatus)
    }

    // MARK: - Teardown

    private func teardown() {
        lock.lock()
        let existingTap = tap
        let existingSource = runLoopSource
        let ready = runLoopReady
        tap = nil
        runLoopSource = nil
        gate.forgetHeld()
        lock.unlock()

        guard existingTap != nil || existingSource != nil else {
            return
        }

        if let existingTap = existingTap {
            CGEvent.tapEnable(tap: existingTap, enable: false)
        }

        // Wait briefly for the thread to publish its run loop. A timeout is not
        // a failure: invalidating the source below ends `CFRunLoopRun` anyway.
        _ = ready.wait(timeout: .now() + .milliseconds(500))

        lock.lock()
        let loop = tapRunLoop
        lock.unlock()

        if let existingSource = existingSource {
            CFRunLoopSourceInvalidate(existingSource)
        }
        if let existingTap = existingTap {
            CFMachPortInvalidate(existingTap)
        }
        if let loop = loop {
            CFRunLoopStop(loop)
        }
    }

    // MARK: - Status

    private func finish(
        state: HotkeyTapState,
        detail: String,
        change: HotkeyTapChange
    ) -> HotkeyStatus {
        let trusted = AXIsProcessTrusted()
        lock.lock()
        tapState = state
        self.detail = detail
        let status = statusLocked(accessibilityTrusted: trusted)
        lock.unlock()
        onTapChange?(change, status)
        return status
    }

    /// Caller must hold `lock`.
    private func statusLocked(
        accessibilityTrusted: Bool,
        overrideState: HotkeyTapState? = nil,
        overrideDetail: String? = nil
    ) -> HotkeyStatus {
        HotkeyStatus(
            binding: gate.binding,
            tap: overrideState ?? tapState,
            accessibilityTrusted: accessibilityTrusted,
            held: gate.held,
            detail: overrideDetail ?? detail,
            counters: counters
        )
    }
}
