import Foundation

/// Pointer and accessibility records, and the **pure** logic that produces them.
///
/// Everything in this file is Foundation-only and therefore covered by
/// `swift test`: the secure-field classifier, the label preference order, the
/// AppKit coordinate flip, the text clamps and the JSON serialisation. The
/// ApplicationServices calls that feed it live in `AccessibilityProbes.swift`,
/// which — like `PermissionProbes.swift` and `WindowEnumerator.swift` — is the
/// part that has never been compiled (runbook amendment 8).
///
/// Mirrors `packages/platform-mac/src/protocol/accessibility-ops.ts`.

// MARK: - Points

public struct PointRecord: Equatable {
    public let x: Double
    public let y: Double

    public init(x: Double, y: Double) {
        self.x = x
        self.y = y
    }

    public var jsonObject: [String: Any] {
        ["x": x, "y": y]
    }
}

/// How the pointer position was read, or why it could not be.
public enum PointerSource: String {
    /// `CGEvent(source: nil)?.location`. Global, top-left origin, no grant needed.
    case cgEvent = "cg-event"
    /// `NSEvent.mouseLocation`, flipped from AppKit's bottom-left origin.
    case nsEvent = "ns-event"
    case unavailable
}

/// Coordinate conversions the pointer path needs.
///
/// Only one is needed, and it exists because the two ways macOS reports the
/// mouse disagree about which corner is the origin:
///
/// - `CGEvent(source: nil)?.location` is **top-left** origin, the same space as
///   `kCGWindowBounds` and `AXFrame`. Nothing to convert; it is preferred.
/// - `NSEvent.mouseLocation` is **bottom-left** origin, measured against the
///   primary display. It is the fallback, and it must be flipped.
///
/// Getting that flip wrong is invisible near the vertical middle of the screen
/// and grows to the height of the display at the edges, which is exactly the
/// kind of bug that survives a casual look at a demo. It is pure arithmetic, so
/// it is tested instead.
public enum AccessibilityGeometry {
    /// AppKit bottom-left origin → CoreGraphics top-left origin.
    ///
    /// `primaryDisplayHeight` is the height of the display whose origin is
    /// `(0, 0)`, because that is the one AppKit measures from — not the height
    /// of the display the pointer happens to be over.
    public static func flippedFromAppKit(
        _ point: PointRecord,
        primaryDisplayHeight: Double
    ) -> PointRecord {
        PointRecord(x: point.x, y: primaryDisplayHeight - point.y)
    }
}

// MARK: - Secure fields

/// Why an element is (or is not) considered secure. Ordered strongest first.
public enum SecureFieldBasis: String {
    case role
    case subrole
    case ancestor
    case none
}

public struct SecureFieldVerdict: Equatable {
    public let isSecure: Bool
    public let basis: SecureFieldBasis
    /// Ancestor distance at which a secure field was found; `nil` otherwise.
    public let ancestorDepth: Int?

    public init(isSecure: Bool, basis: SecureFieldBasis, ancestorDepth: Int?) {
        self.isSecure = isSecure
        self.basis = basis
        self.ancestorDepth = ancestorDepth
    }

    public static let notSecure = SecureFieldVerdict(
        isSecure: false, basis: .none, ancestorDepth: nil)
}

/// One element's role pair, as the classifier sees it.
public struct AccessibilityRolePair: Equatable {
    public let role: String?
    public let subrole: String?

    public init(role: String?, subrole: String?) {
        self.role = role
        self.subrole = subrole
    }
}

/// Secure-field classification. **Best effort, by design and by admission.**
///
/// system-design §14: "Accessibility-based redaction is best effort. Password
/// fields can be masked when identified, but the product must warn that
/// screenshots can still contain secrets outside recognized fields."
///
/// What this recognises is exactly what macOS marks:
///
/// - `AXRole == AXSecureTextField` — an `NSSecureTextField` in a native app.
/// - `AXSubrole == AXSecureTextField` — how AppKit's text system and WebKit
///   mark a password input; the role there is the ordinary `AXTextField`.
/// - the same on an ancestor within `maxAncestorDepth`, which catches the inner
///   text element of a composed secure field, whose own role is generic.
///
/// What it does **not** recognise, and no amount of tuning here would:
/// a token pasted into a plain text view, a secret drawn into a canvas or a
/// PDF, an API key in a window title, a recovery phrase in a chat transcript.
/// Nothing marks those, so `basis == .none` means "macOS did not mark this",
/// never "this is safe". Deliberately no heuristics on labels: guessing
/// "Password" from a placeholder would create the *appearance* of coverage
/// while leaving every non-English and every unlabelled field uncovered, which
/// is worse than a limit that is stated plainly.
public enum SecureFieldClassifier {
    /// How far up the tree the walk goes. Bounded: this runs on the 30 Hz path.
    public static let maxAncestorDepth = 4

    public static func isSecureRole(_ value: String?) -> Bool {
        value == AccessibilityAttribute.secureTextFieldRole
    }

    /// `ancestors` is ordered nearest-first; index 0 is the element's parent.
    public static func classify(
        role: String?,
        subrole: String?,
        ancestors: [AccessibilityRolePair] = []
    ) -> SecureFieldVerdict {
        if isSecureRole(role) {
            return SecureFieldVerdict(isSecure: true, basis: .role, ancestorDepth: nil)
        }
        if isSecureRole(subrole) {
            return SecureFieldVerdict(isSecure: true, basis: .subrole, ancestorDepth: nil)
        }
        var depth = 0
        for ancestor in ancestors {
            depth += 1
            if depth > maxAncestorDepth {
                break
            }
            if isSecureRole(ancestor.role) || isSecureRole(ancestor.subrole) {
                return SecureFieldVerdict(isSecure: true, basis: .ancestor, ancestorDepth: depth)
            }
        }
        return .notSecure
    }
}

// MARK: - Attributes

/// Accessibility attribute names, as literals.
///
/// Literals rather than the `kAX…` constants for the same reason
/// `WindowInfoKey` uses literals: this file then imports nothing but
/// Foundation and stays testable off a Mac. The values are fixed by the API.
public enum AccessibilityAttribute {
    public static let role = "AXRole"
    public static let subrole = "AXSubrole"
    public static let title = "AXTitle"
    public static let description = "AXDescription"
    public static let value = "AXValue"
    public static let placeholder = "AXPlaceholderValue"
    public static let frame = "AXFrame"
    public static let parent = "AXParent"
    public static let secureTextFieldRole = "AXSecureTextField"
}

/// Text handling shared by every attribute read.
public enum AccessibilityText {
    /// Longest label kept. Matches `accessibilityElementSchema` on the host,
    /// which rejects anything longer — the helper clamps so a pathological
    /// element degrades rather than failing the schema.
    public static let maxLabelLength = 500

    /// Trims, drops the empty string, and clamps. Empty is `nil`, not `""`:
    /// "this element has no title" and "its title is the empty string" are the
    /// same thing to a reader and there is no value in distinguishing them.
    public static func normalize(_ value: String?, max: Int = maxLabelLength) -> String? {
        guard let value = value else {
            return nil
        }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            return nil
        }
        if trimmed.count <= max {
            return trimmed
        }
        return String(trimmed.prefix(max))
    }

    /// The label, in preference order: title, then description, then the value
    /// of a title element, then a placeholder. First non-empty wins; a
    /// placeholder is last because it describes what *could* be typed rather
    /// than what the element is.
    public static func label(
        title: String?,
        description: String?,
        titleElementValue: String?,
        placeholder: String?
    ) -> String? {
        for candidate in [title, description, titleElementValue, placeholder] {
            if let normalized = normalize(candidate) {
                return normalized
            }
        }
        return nil
    }
}

// MARK: - Elements

/// What a hit test did.
public enum ElementOutcome: String {
    case reported
    case noElement = "no-element"
    case notTrusted = "not-trusted"
    case queryFailed = "query-failed"
    case notRequested = "not-requested"
}

public struct AccessibilityElementRecord {
    public let role: String?
    public let subrole: String?
    public let label: String?
    public let value: String?
    public let bounds: RectRecord?
    public let secure: SecureFieldVerdict
    public let ownerPid: Int?

    public init(
        role: String?,
        subrole: String?,
        label: String?,
        value: String?,
        bounds: RectRecord?,
        secure: SecureFieldVerdict,
        ownerPid: Int?
    ) {
        self.role = role
        self.subrole = subrole
        self.label = label
        self.value = value
        self.bounds = bounds
        self.secure = secure
        self.ownerPid = ownerPid
    }

    /// Drops the value unless the caller asked for it **and** the element is
    /// not secure.
    ///
    /// This is the first of three places a secure value is discarded; the host
    /// drops it again in `toAccessibilityNode` and a third time in
    /// `buildGroundedPointer`. The redundancy is free and the failure it guards
    /// against is a password in a model transcript.
    public func redacted(includeValue: Bool) -> AccessibilityElementRecord {
        if includeValue && !secure.isSecure {
            return self
        }
        return AccessibilityElementRecord(
            role: role,
            subrole: subrole,
            label: label,
            value: nil,
            bounds: bounds,
            secure: secure,
            ownerPid: ownerPid
        )
    }

    public var jsonObject: [String: Any] {
        [
            "role": JSONValue.orNull(role),
            "subrole": JSONValue.orNull(subrole),
            "label": JSONValue.orNull(label),
            "value": JSONValue.orNull(value),
            "bounds": JSONValue.orNull(bounds?.jsonObject),
            "isSecure": secure.isSecure,
            "secureBasis": secure.basis.rawValue,
            "secureAncestorDepth": JSONValue.orNull(secure.ancestorDepth),
            "ownerPid": JSONValue.orNull(ownerPid),
        ]
    }
}

/// The result of one hit test: an element, or the reason there is none.
public struct ElementLookup {
    public let element: AccessibilityElementRecord?
    public let outcome: ElementOutcome

    public init(element: AccessibilityElementRecord?, outcome: ElementOutcome) {
        self.element = element
        self.outcome = outcome
    }

    public static let notRequested = ElementLookup(element: nil, outcome: .notRequested)
    public static let notTrusted = ElementLookup(element: nil, outcome: .notTrusted)
    public static let queryFailed = ElementLookup(element: nil, outcome: .queryFailed)
    public static let noElement = ElementLookup(element: nil, outcome: .noElement)

    public var jsonFields: [String: Any] {
        [
            "element": JSONValue.orNull(element?.jsonObject),
            "outcome": outcome.rawValue,
        ]
    }
}

/// The result of one pointer read.
public struct PointerReading {
    public let point: PointRecord
    public let source: PointerSource
    public let sampledAt: Int

    public init(point: PointRecord, source: PointerSource, sampledAt: Int) {
        self.point = point
        self.source = source
        self.sampledAt = sampledAt
    }

    public var jsonFields: [String: Any] {
        [
            "point": point.jsonObject,
            "pointerSource": source.rawValue,
            "sampledAt": sampledAt,
        ]
    }
}
