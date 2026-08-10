import Foundation

/// Attribution evidence: what the helper can observe about which identity
/// macOS credits its permission grants to.
///
/// The helper reports facts and reaches no conclusion. The verdict is computed
/// on the host, in `src/permissions/attribution.ts`, for one reason: that code
/// can be run and tested on the Linux development machine, and this cannot
/// (runbook amendment 8). Keeping the decision out of Swift keeps the part
/// nobody has executed as small and as dumb as possible.
///
/// See the host module for what the verdict means and why it matters.

public struct AttributionEvidence {
    public let helperPid: Int
    public let parentPid: Int
    public let helperExecutablePath: String?
    public let helperBundleIdentifier: String?
    public let enclosingAppBundlePath: String?
    public let enclosingAppBundleIdentifier: String?
    public let responsibleProcessPid: Int?
    public let responsibleProcessQueried: Bool
    public let mainBundleIsApp: Bool

    public init(
        helperPid: Int,
        parentPid: Int,
        helperExecutablePath: String?,
        helperBundleIdentifier: String?,
        enclosingAppBundlePath: String?,
        enclosingAppBundleIdentifier: String?,
        responsibleProcessPid: Int?,
        responsibleProcessQueried: Bool,
        mainBundleIsApp: Bool
    ) {
        self.helperPid = helperPid
        self.parentPid = parentPid
        self.helperExecutablePath = helperExecutablePath
        self.helperBundleIdentifier = helperBundleIdentifier
        self.enclosingAppBundlePath = enclosingAppBundlePath
        self.enclosingAppBundleIdentifier = enclosingAppBundleIdentifier
        self.responsibleProcessPid = responsibleProcessPid
        self.responsibleProcessQueried = responsibleProcessQueried
        self.mainBundleIsApp = mainBundleIsApp
    }

    /// `NSNull` rather than an omitted key: the host's schema is strict and
    /// distinguishes "unavailable" from "absent".
    public var jsonObject: [String: Any] {
        [
            "helperPid": helperPid,
            "parentPid": parentPid,
            "helperExecutablePath": JSONValue.orNull(helperExecutablePath),
            "helperBundleIdentifier": JSONValue.orNull(helperBundleIdentifier),
            "enclosingAppBundlePath": JSONValue.orNull(enclosingAppBundlePath),
            "enclosingAppBundleIdentifier": JSONValue.orNull(enclosingAppBundleIdentifier),
            "responsibleProcessPid": JSONValue.orNull(responsibleProcessPid),
            "responsibleProcessQueried": responsibleProcessQueried,
            "mainBundleIsApp": mainBundleIsApp,
        ]
    }
}

/// Optional → `Any`, as `NSNull` when absent.
///
/// Written as overloads rather than `value ?? NSNull()` inline: the coalescing
/// form relies on the compiler finding `Any` as the common supertype of the two
/// branches, which is exactly the kind of inference this package cannot afford
/// to be wrong about — nothing here has ever been compiled.
public enum JSONValue {
    public static func orNull(_ value: String?) -> Any {
        if let value = value {
            return value
        }
        return NSNull()
    }

    public static func orNull(_ value: Int?) -> Any {
        if let value = value {
            return value
        }
        return NSNull()
    }

    public static func orNull(_ value: [String: Any]?) -> Any {
        if let value = value {
            return value
        }
        return NSNull()
    }
}

/// Pure path arithmetic over bundle layouts. No filesystem access, so the
/// tests can cover the layouts that matter without constructing them on disk.
public enum BundlePath {
    /// The **nearest** enclosing `.app` directory of an executable path.
    ///
    /// Nearest, not outermost, on purpose. A helper at
    /// `Pilot.app/Contents/Library/Inner.app/Contents/MacOS/Helper` is inside
    /// two bundles, and the one that would carry a separate TCC identity is
    /// `Inner.app`. Reporting the outer bundle would hide exactly the nesting
    /// that causes misattribution.
    ///
    /// Returns `nil` for a loose executable — the development layout, where
    /// the helper is run straight out of `.build/debug`.
    public static func enclosingAppBundle(of path: String) -> String? {
        let components = path.split(separator: "/", omittingEmptySubsequences: false).map(String.init)
        var index = components.count - 1
        while index >= 0 {
            let component = components[index]
            if component.count > 4 && component.hasSuffix(".app") {
                let joined = components[0...index].joined(separator: "/")
                return joined.isEmpty ? "/" : joined
            }
            index -= 1
        }
        return nil
    }

    /// Whether a path names an application bundle directory.
    public static func isAppBundle(_ path: String) -> Bool {
        guard let last = path.split(separator: "/").last else {
            return false
        }
        return last.count > 4 && last.hasSuffix(".app")
    }
}
