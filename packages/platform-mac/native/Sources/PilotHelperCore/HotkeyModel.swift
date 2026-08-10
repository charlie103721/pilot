import Foundation

/// Push-to-talk hotkey vocabulary and decision logic, with **no framework
/// imports** (PR-015).
///
/// Same split as PR-011's `PermissionModel.swift`: everything that can be a
/// pure function of its arguments lives here, where `swift test` can prove it,
/// and only the calls that must touch CoreGraphics live in `HotkeyTap.swift`.
/// On a machine with no Swift toolchain and no Mac (runbook amendment 8) that
/// boundary is the difference between code that is checked and code that is
/// merely written.
///
/// Mirrors `packages/platform-mac/src/protocol/hotkey-ops.ts` and
/// `packages/platform/src/hotkey.ts`.

public enum HotkeyPhase: String {
    case down
    case up
}

public struct HotkeyBinding: Equatable {
    public let keyCode: Int
    public let label: String
    public let isModifierKey: Bool
    /// Modifier names from `HOTKEY_MODIFIERS`: command, option, control, shift, fn.
    public let requiredModifiers: [String]

    public init(keyCode: Int, label: String, isModifierKey: Bool, requiredModifiers: [String]) {
        self.keyCode = keyCode
        self.label = label
        self.isModifierKey = isModifierKey
        self.requiredModifiers = requiredModifiers
    }

    /// Right Option, held. See `DEFAULT_PUSH_TO_TALK_BINDING` for why.
    public static let defaultPushToTalk = HotkeyBinding(
        keyCode: 61,  // kVK_RightOption
        label: "Right Option",
        isModifierKey: true,
        requiredModifiers: []
    )

    public var jsonObject: [String: Any] {
        [
            "keyCode": keyCode,
            "label": label,
            "isModifierKey": isModifierKey,
            "requiredModifiers": requiredModifiers,
        ]
    }

    /// Reads a binding off a request payload. `nil` rather than a default: a
    /// malformed binding must be an `invalid-request`, not a silent rebinding
    /// to some other key than the one the user configured.
    public static func from(payload: [String: Any]?) -> HotkeyBinding? {
        guard let payload = payload else {
            return nil
        }
        guard let keyCode = (payload["keyCode"] as? NSNumber)?.intValue,
            keyCode >= 0,
            keyCode <= 0xFFFF,
            let label = payload["label"] as? String,
            !label.isEmpty,
            label.count <= 64,
            let isModifierKey = payload["isModifierKey"] as? Bool
        else {
            return nil
        }
        let rawModifiers = payload["requiredModifiers"] as? [Any] ?? []
        var modifiers: [String] = []
        for raw in rawModifiers {
            guard let name = raw as? String, HotkeyModifierMask.mask(for: name) != nil else {
                return nil
            }
            modifiers.append(name)
        }
        return HotkeyBinding(
            keyCode: keyCode,
            label: label,
            isModifierKey: isModifierKey,
            requiredModifiers: modifiers
        )
    }
}

/// The device-dependent flag bit each modifier *key* raises.
///
/// `CGEventFlags` carries two layers: the general masks (`maskAlternate` and
/// friends), which cannot tell left from right, and the low device-dependent
/// bits from `IOLLEvent.h`, which can. Push-to-talk defaults to **Right**
/// Option specifically — Left Option types accented characters on a US layout
/// and is a live dead-key modifier on many others — so the distinction is not
/// a nicety here, it is the whole binding.
///
/// Values are `NX_DEVICE*KEYMASK` from `IOKit/hidsystem/IOLLEvent.h`. They are
/// written out rather than imported because IOKit's header is not visible from
/// a plain Swift target and the constants are stable ABI.
public enum HotkeyDeviceMask {
    public static let leftControl: UInt64 = 0x0000_0001
    public static let leftShift: UInt64 = 0x0000_0002
    public static let rightShift: UInt64 = 0x0000_0004
    public static let leftCommand: UInt64 = 0x0000_0008
    public static let rightCommand: UInt64 = 0x0000_0010
    public static let leftOption: UInt64 = 0x0000_0020
    public static let rightOption: UInt64 = 0x0000_0040
    public static let rightControl: UInt64 = 0x0000_2000
    public static let secondaryFn: UInt64 = 0x0080_0000

    /// The bit that is set while this modifier key is physically down, or `nil`
    /// when the key code is not a modifier this table knows.
    public static func mask(forKeyCode keyCode: Int) -> UInt64? {
        switch keyCode {
        case 54: return rightCommand  // kVK_RightCommand
        case 55: return leftCommand  // kVK_Command
        case 56: return leftShift  // kVK_Shift
        case 58: return leftOption  // kVK_Option
        case 59: return leftControl  // kVK_Control
        case 60: return rightShift  // kVK_RightShift
        case 61: return rightOption  // kVK_RightOption
        case 62: return rightControl  // kVK_RightControl
        case 63: return secondaryFn  // kVK_Function
        default: return nil
        }
    }
}

/// The general `CGEventFlags` masks, used for `requiredModifiers`.
public enum HotkeyModifierMask {
    public static let shift: UInt64 = 0x0002_0000
    public static let control: UInt64 = 0x0004_0000
    public static let option: UInt64 = 0x0008_0000
    public static let command: UInt64 = 0x0010_0000
    public static let fn: UInt64 = 0x0080_0000

    public static func mask(for name: String) -> UInt64? {
        switch name {
        case "shift": return shift
        case "control": return control
        case "option": return option
        case "command": return command
        case "fn": return fn
        default: return nil
        }
    }

    public static func combined(_ names: [String]) -> UInt64 {
        var result: UInt64 = 0
        for name in names {
            if let mask = mask(for: name) {
                result |= mask
            }
        }
        return result
    }
}

/// Which kind of keyboard event this is, without importing CoreGraphics.
public enum HotkeyEventKind {
    case keyDown
    case keyUp
    case flagsChanged
}

/// One event as the tap saw it, reduced to the four values the gate may read.
///
/// This struct *is* the privacy boundary in type form: there is no character,
/// no unicode string, no event timestamp chain and no arbitrary field on it, so
/// no amount of downstream code can log something the gate was never given.
public struct HotkeyRawInput {
    public let keyCode: Int
    public let kind: HotkeyEventKind
    public let flags: UInt64
    public let autorepeat: Bool

    public init(keyCode: Int, kind: HotkeyEventKind, flags: UInt64, autorepeat: Bool) {
        self.keyCode = keyCode
        self.kind = kind
        self.flags = flags
        self.autorepeat = autorepeat
    }
}

public enum HotkeyIgnoreReason: String, Equatable {
    /// Not the configured key. The overwhelmingly common case.
    case otherKey = "other-key"
    /// A modifier binding saw a key-down/up, or a normal binding saw flagsChanged.
    case wrongEventKind = "wrong-event-kind"
    /// The binding names a modifier key code this build has no mask for.
    case unknownModifierKey = "unknown-modifier-key"
    /// The platform marked the event a key repeat.
    case autorepeat = "auto-repeat"
    /// A required modifier was not held.
    case modifiersNotHeld = "modifiers-not-held"
    /// A second down with no intervening up.
    case alreadyHeld = "already-held"
    /// An up with nothing held.
    case notHeld = "not-held"
}

public enum HotkeyDecision: Equatable {
    case emit(HotkeyPhase)
    case ignore(HotkeyIgnoreReason)
}

/// The native half of event coalescing, as a pure state machine.
///
/// It decides two things and nothing else: is this the configured key, and is
/// this transition worth telling the host about. Both matter:
///
/// - The first is the keylogger guard. `decide` returns `.ignore(.otherKey)`
///   before it reads `flags`, before it reads `autorepeat`, and before it
///   touches any state at all. The key code is compared and dropped in the same
///   expression; nothing about a foreign key is stored, copied or forwarded.
/// - The second is the storm guard. Holding a normal key produces auto-repeat
///   key-downs at the system repeat rate, and PR-025's demo shows what reaches
///   the interaction machine without this: one `illegal-transition` per repeat.
///   The host coalesces again (`src/hotkey/coalescer.ts`) — this layer keeps
///   the frames off the wire in the first place.
public final class HotkeyGate {
    public private(set) var binding: HotkeyBinding
    public private(set) var held = false
    public private(set) var emitted = 0
    public private(set) var suppressed = 0

    public init(binding: HotkeyBinding = .defaultPushToTalk) {
        self.binding = binding
    }

    /// Rebinds and forgets any held state: the user is no longer holding the
    /// key this gate is now watching.
    public func rebind(_ binding: HotkeyBinding) {
        self.binding = binding
        held = false
    }

    /// Clears held state without emitting. Used when the tap goes away — the
    /// host synthesises the release, because only the host can be sure the
    /// consumer heard it.
    public func forgetHeld() {
        held = false
    }

    public func decide(_ input: HotkeyRawInput) -> HotkeyDecision {
        guard input.keyCode == binding.keyCode else {
            return .ignore(.otherKey)
        }

        let phase: HotkeyPhase
        if binding.isModifierKey {
            guard input.kind == .flagsChanged else {
                return note(.wrongEventKind)
            }
            guard let deviceMask = HotkeyDeviceMask.mask(forKeyCode: binding.keyCode) else {
                return note(.unknownModifierKey)
            }
            phase = (input.flags & deviceMask) != 0 ? .down : .up
        } else {
            switch input.kind {
            case .keyDown: phase = .down
            case .keyUp: phase = .up
            case .flagsChanged: return note(.wrongEventKind)
            }
        }

        if input.autorepeat {
            return note(.autorepeat)
        }

        if phase == .down {
            let required = HotkeyModifierMask.combined(binding.requiredModifiers)
            // Only checked on the press. Users release a chord in whatever
            // order their hand leaves the keyboard, and refusing the release
            // because the modifier went first would strand the press open.
            if required != 0 && (input.flags & required) != required {
                return note(.modifiersNotHeld)
            }
            if held {
                return note(.alreadyHeld)
            }
            held = true
            emitted += 1
            return .emit(.down)
        }

        if !held {
            return note(.notHeld)
        }
        held = false
        emitted += 1
        return .emit(.up)
    }

    private func note(_ reason: HotkeyIgnoreReason) -> HotkeyDecision {
        suppressed += 1
        return .ignore(reason)
    }
}

/// How many times a disabled tap may be switched back on before Pilot stops
/// trying.
///
/// macOS disables an event tap whose callback overran its deadline
/// (`kCGEventTapDisabledByTimeout`) and when user-input taps are switched off
/// wholesale (`kCGEventTapDisabledByUserInput`). Re-enabling is the correct
/// response to both, but re-enabling *forever* turns a systematic problem into
/// an invisible one: if the tap is being killed every second, the user needs to
/// be told the shortcut is broken, not have Pilot quietly fight the OS.
public struct HotkeyRecoveryBudget {
    public let maxRestores: Int
    public let windowSeconds: Double
    private var restores: [Double] = []

    public init(maxRestores: Int = 5, windowSeconds: Double = 60) {
        self.maxRestores = maxRestores
        self.windowSeconds = windowSeconds
    }

    /// Records an attempt and answers whether it is within budget.
    public mutating func allow(now: Double) -> Bool {
        restores.removeAll { now - $0 >= windowSeconds }
        restores.append(now)
        return restores.count <= maxRestores
    }

    public var used: Int { restores.count }
}

public enum HotkeyTapState: String {
    case active
    case stopped
    case accessibilityDenied = "accessibility-denied"
    case creationFailed = "creation-failed"
    case disabled
}

public enum HotkeyTapChange: String {
    case started
    case stopped
    case disabledByTimeout = "disabled-by-timeout"
    case disabledByUserInput = "disabled-by-user-input"
    case reEnabled = "re-enabled"
    case failed
}

public struct HotkeyCounters: Equatable {
    public var emitted: Int
    public var suppressed: Int
    public var disabledByTimeout: Int
    public var disabledByUserInput: Int
    public var reEnabled: Int

    public init(
        emitted: Int = 0,
        suppressed: Int = 0,
        disabledByTimeout: Int = 0,
        disabledByUserInput: Int = 0,
        reEnabled: Int = 0
    ) {
        self.emitted = emitted
        self.suppressed = suppressed
        self.disabledByTimeout = disabledByTimeout
        self.disabledByUserInput = disabledByUserInput
        self.reEnabled = reEnabled
    }

    public var jsonObject: [String: Any] {
        [
            "emitted": emitted,
            "suppressed": suppressed,
            "disabledByTimeout": disabledByTimeout,
            "disabledByUserInput": disabledByUserInput,
            "reEnabled": reEnabled,
        ]
    }
}

public struct HotkeyStatus {
    public let binding: HotkeyBinding
    public let tap: HotkeyTapState
    public let accessibilityTrusted: Bool
    public let held: Bool
    public let detail: String
    public let counters: HotkeyCounters

    public init(
        binding: HotkeyBinding,
        tap: HotkeyTapState,
        accessibilityTrusted: Bool,
        held: Bool,
        detail: String,
        counters: HotkeyCounters
    ) {
        self.binding = binding
        self.tap = tap
        self.accessibilityTrusted = accessibilityTrusted
        self.held = held
        // The wire caps this at 200 characters; truncate here rather than emit
        // a frame the host would reject as a schema violation.
        self.detail = String(detail.prefix(200))
        self.counters = counters
    }

    public var jsonObject: [String: Any] {
        [
            "binding": binding.jsonObject,
            "tap": tap.rawValue,
            "accessibilityTrusted": accessibilityTrusted,
            "held": held,
            "detail": detail,
            "counters": counters.jsonObject,
        ]
    }
}

/// One transition, in the exact shape `hotkey.key` carries.
public struct HotkeyKeyReport {
    public let phase: HotkeyPhase
    public let keyCode: Int
    public let at: Int
    public let sequence: Int
    public let autorepeat: Bool

    public init(phase: HotkeyPhase, keyCode: Int, at: Int, sequence: Int, autorepeat: Bool) {
        self.phase = phase
        self.keyCode = keyCode
        self.at = at
        self.sequence = sequence
        self.autorepeat = autorepeat
    }

    public var jsonObject: [String: Any] {
        [
            "phase": phase.rawValue,
            "keyCode": keyCode,
            "at": at,
            "sequence": sequence,
            "autorepeat": autorepeat,
        ]
    }
}
