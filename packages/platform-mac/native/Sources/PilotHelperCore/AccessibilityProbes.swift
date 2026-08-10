import AppKit
import ApplicationServices
import CoreGraphics
import Foundation

/// The Accessibility-API-touching half of pointer grounding.
///
/// **None of this file has ever been compiled or run** (runbook amendment 8).
/// Written the same way as `PermissionProbes.swift` and
/// `WindowEnumerator.swift`: no concurrency, no generics, no availability
/// gymnastics, one framework call per function, and every failure degrading to
/// a value rather than a trap. Everything that could be pure was moved to
/// `AccessibilityModel.swift`, which `swift test` does cover.
///
/// The protocol exists so `HelperServer` can be driven by a stub in tests.

public protocol AccessibilityService {
    /// `AXIsProcessTrusted()`. False means no hit test can run.
    func isTrusted() -> Bool
    /// The pointer position, in global top-left-origin screen points.
    func pointer() -> PointerReading
    /// The element at a screen point, optionally confined to one application.
    func element(at point: PointRecord, ownerPid: Int?, includeValue: Bool) -> ElementLookup
}

public final class SystemAccessibilityService: AccessibilityService {
    /// Ceiling on one accessibility round trip, in seconds.
    ///
    /// This matters more here than anywhere else in the helper. The stdio loop
    /// is single-threaded and pointer sampling runs at ~30 Hz; an application
    /// that is busy or wedged answers its accessibility queries slowly or not
    /// at all, and the default timeout would stall `health` behind it until the
    /// host's supervisor concluded the helper was dead and killed it. 200 ms is
    /// well under the 33 ms period × the host's request deadline, so a slow app
    /// costs a dropped sample rather than a restart.
    private static let messagingTimeout: Float = 0.2

    private let systemWide: AXUIElement
    /// One `AXUIElementCreateApplication` per pid, kept for the helper's life.
    /// Creating one is cheap but not free, and this is on the 30 Hz path.
    private var applicationElements: [Int: AXUIElement] = [:]

    public init() {
        systemWide = AXUIElementCreateSystemWide()
        AXUIElementSetMessagingTimeout(systemWide, Self.messagingTimeout)
    }

    public func isTrusted() -> Bool {
        AXIsProcessTrusted()
    }

    // MARK: - Pointer

    /// The pointer position.
    ///
    /// `CGEvent(source: nil)?.location` is preferred: it is already in the
    /// global, top-left-origin space that `kCGWindowBounds` and `AXFrame` use,
    /// so no conversion is needed and no display height has to be guessed. It
    /// also needs **no Accessibility grant**, which is what makes the degraded
    /// mode of system-design §16 real — with Accessibility denied, the position
    /// still arrives and only the element goes missing.
    ///
    /// `NSEvent.mouseLocation` is the fallback and is bottom-left origin, so it
    /// is flipped by `AccessibilityGeometry` against the primary display's
    /// height. That conversion is pure and is unit-tested.
    public func pointer() -> PointerReading {
        let now = HelperProtocol.now()
        if let location = CGEvent(source: nil)?.location {
            return PointerReading(
                point: PointRecord(x: Double(location.x), y: Double(location.y)),
                source: .cgEvent,
                sampledAt: now
            )
        }
        let mouse = NSEvent.mouseLocation
        let height = Self.primaryDisplayHeight()
        if height > 0 {
            let flipped = AccessibilityGeometry.flippedFromAppKit(
                PointRecord(x: Double(mouse.x), y: Double(mouse.y)),
                primaryDisplayHeight: height
            )
            return PointerReading(point: flipped, source: .nsEvent, sampledAt: now)
        }
        return PointerReading(point: PointRecord(x: 0, y: 0), source: .unavailable, sampledAt: now)
    }

    /// Height of the display whose origin is `(0, 0)` — the one AppKit
    /// measures `NSEvent.mouseLocation` from. CoreGraphics only, so it does not
    /// depend on this process having a window-server connection through AppKit.
    private static func primaryDisplayHeight() -> Double {
        let bounds = CGDisplayBounds(CGMainDisplayID())
        return Double(bounds.size.height)
    }

    // MARK: - Hit testing

    public func element(
        at point: PointRecord,
        ownerPid: Int?,
        includeValue: Bool
    ) -> ElementLookup {
        if !isTrusted() {
            return .notTrusted
        }
        // Scoped to the owning application where one is named. This is the
        // native half of the outside-window rule: an application element cannot
        // answer with another application's element, so a window stacked on top
        // of the selected one cannot be described.
        let root = ownerPid.map { applicationElement(for: $0) } ?? systemWide
        var hit: AXUIElement?
        let status = AXUIElementCopyElementAtPosition(
            root, Float(point.x), Float(point.y), &hit)
        if status == .noValue || status == .invalidUIElement {
            return .noElement
        }
        guard status == .success, let element = hit else {
            return .queryFailed
        }
        return ElementLookup(element: describe(element, includeValue: includeValue), outcome: .reported)
    }

    private func applicationElement(for pid: Int) -> AXUIElement {
        if let cached = applicationElements[pid] {
            return cached
        }
        let element = AXUIElementCreateApplication(pid_t(pid))
        AXUIElementSetMessagingTimeout(element, Self.messagingTimeout)
        applicationElements[pid] = element
        return element
    }

    private func describe(_ element: AXUIElement, includeValue: Bool) -> AccessibilityElementRecord {
        let role = AccessibilityText.normalize(string(element, AccessibilityAttribute.role))
        let subrole = AccessibilityText.normalize(string(element, AccessibilityAttribute.subrole))
        let secure = SecureFieldClassifier.classify(
            role: role,
            subrole: subrole,
            ancestors: ancestorRoles(of: element)
        )
        let label = AccessibilityText.label(
            title: string(element, AccessibilityAttribute.title),
            description: string(element, AccessibilityAttribute.description),
            titleElementValue: nil,
            placeholder: string(element, AccessibilityAttribute.placeholder)
        )
        // The value is read only when it is wanted and the element is not
        // secure. Not reading it at all is stronger than reading and dropping:
        // a secure value never enters this process's memory.
        let value =
            includeValue && !secure.isSecure
            ? AccessibilityText.normalize(string(element, AccessibilityAttribute.value))
            : nil

        return AccessibilityElementRecord(
            role: role,
            subrole: subrole,
            label: label,
            value: value,
            bounds: frame(of: element),
            secure: secure,
            ownerPid: pid(of: element)
        )
    }

    /// Roles of the element's ancestors, nearest first, bounded by the
    /// classifier's depth. Bounded because this runs on the 30 Hz path and an
    /// unbounded walk over a deep web document would not finish in a frame.
    private func ancestorRoles(of element: AXUIElement) -> [AccessibilityRolePair] {
        var pairs: [AccessibilityRolePair] = []
        var current = element
        var depth = 0
        while depth < SecureFieldClassifier.maxAncestorDepth {
            depth += 1
            guard let parent = copyElement(current, AccessibilityAttribute.parent) else {
                break
            }
            pairs.append(
                AccessibilityRolePair(
                    role: AccessibilityText.normalize(string(parent, AccessibilityAttribute.role)),
                    subrole: AccessibilityText.normalize(
                        string(parent, AccessibilityAttribute.subrole))
                )
            )
            current = parent
        }
        return pairs
    }

    // MARK: - Attribute reads
    //
    // Each of these can fail independently and each failure is `nil`. An
    // element with a role and no title is ordinary, not an error.

    private func copyAttribute(_ element: AXUIElement, _ attribute: String) -> CFTypeRef? {
        var value: CFTypeRef?
        let status = AXUIElementCopyAttributeValue(element, attribute as CFString, &value)
        return status == .success ? value : nil
    }

    private func string(_ element: AXUIElement, _ attribute: String) -> String? {
        guard let value = copyAttribute(element, attribute) else {
            return nil
        }
        if let text = value as? String {
            return text
        }
        if let number = value as? NSNumber {
            return number.stringValue
        }
        return nil
    }

    private func copyElement(_ element: AXUIElement, _ attribute: String) -> AXUIElement? {
        guard let value = copyAttribute(element, attribute) else {
            return nil
        }
        guard CFGetTypeID(value) == AXUIElementGetTypeID() else {
            return nil
        }
        // The type check above is what makes this cast safe; `as?` does not
        // bridge `AXUIElement`.
        return (value as! AXUIElement)
    }

    /// `AXFrame`, in global top-left-origin screen points — the same space as
    /// window bounds, so no conversion happens anywhere in the helper.
    private func frame(of element: AXUIElement) -> RectRecord? {
        guard let value = copyAttribute(element, AccessibilityAttribute.frame) else {
            return nil
        }
        guard CFGetTypeID(value) == AXValueGetTypeID() else {
            return nil
        }
        var rect = CGRect.zero
        guard AXValueGetValue((value as! AXValue), .cgRect, &rect) else {
            return nil
        }
        return RectRecord(
            x: Double(rect.origin.x),
            y: Double(rect.origin.y),
            width: Double(rect.size.width),
            height: Double(rect.size.height)
        )
    }

    private func pid(of element: AXUIElement) -> Int? {
        var value: pid_t = 0
        guard AXUIElementGetPid(element, &value) == .success, value > 0 else {
            return nil
        }
        return Int(value)
    }
}
