import Foundation

/// Capture state and the **pure** logic around it (PR-012).
///
/// Everything ScreenCaptureKit touches lives in `CaptureEngine.swift`; this
/// file imports Foundation and nothing else, so `swift test` exercises the
/// parts that are easy to get quietly wrong — the request parser and its
/// clamps, the bounded queue and its drop accounting, and the presentation
/// timestamp → wall clock conversion.
///
/// That conversion is the one worth reading twice. `CMSampleBuffer`
/// presentation timestamps are on the mach host clock: milliseconds since the
/// machine booted, not since 1970. `packages/observation`'s frame ring compares
/// `capturedAt` against `Date.now()` and drops anything older than three
/// seconds, so a frame that leaves this process still on the mach base is not
/// an error — it is silence. The conversion happens here, once, before the
/// frame is ever queued.
///
/// Mirrors `packages/platform-mac/src/protocol/capture-ops.ts`.

public enum CaptureEncodingKind: String {
    case jpeg
    case png
}

public enum CaptureStreamState: String {
    case starting
    case streaming
    case protectedContent = "protected"
    case windowLost = "window-lost"
    case screenLocked = "screen-locked"
    case stopped
    case failed
}

/// Bounds, kept in exact agreement with the host's schema.
public enum CaptureLimits {
    public static let maxEdgePixels = 8192
    public static let minFps: Double = 0.2
    public static let maxFps: Double = 30
    public static let defaultQueueDepth = 4
    public static let maxQueueDepth = 32
    public static let defaultQueueByteLimit = 8 * 1024 * 1024
    /// Consecutive blank frames before the window is called protected.
    ///
    /// One blank frame is ordinary: a stream reports blank while it is still
    /// warming up. A window that genuinely blocks capture never stops.
    public static let blankFramesBeforeProtected = 3
}

/// A validated `capture.start` request.
public struct CaptureConfiguration: Equatable {
    public let windowNumber: Int
    public let width: Int
    public let height: Int
    public let sampleFps: Double
    public let includeCursor: Bool
    public let encoding: CaptureEncodingKind
    public let quality: Double
    public let queueDepth: Int
    public let queueByteLimit: Int
    public let resendUnchangedAfterMs: Int
    public let maxFrameAgeMs: Int

    public init(
        windowNumber: Int,
        width: Int,
        height: Int,
        sampleFps: Double,
        includeCursor: Bool,
        encoding: CaptureEncodingKind,
        quality: Double,
        queueDepth: Int,
        queueByteLimit: Int,
        resendUnchangedAfterMs: Int,
        maxFrameAgeMs: Int
    ) {
        self.windowNumber = windowNumber
        self.width = width
        self.height = height
        self.sampleFps = sampleFps
        self.includeCursor = includeCursor
        self.encoding = encoding
        self.quality = quality
        self.queueDepth = queueDepth
        self.queueByteLimit = queueByteLimit
        self.resendUnchangedAfterMs = resendUnchangedAfterMs
        self.maxFrameAgeMs = maxFrameAgeMs
    }

    /// Interval between samples, in milliseconds.
    public var frameIntervalMilliseconds: Int {
        max(1, Int((1000.0 / sampleFps).rounded()))
    }

    /// Parses a request payload, or returns `nil` when it is unusable.
    ///
    /// The size arrives already reduced by the screen policy: the host owns
    /// that rule (`src/capture/capture-policy.ts`) so it is executed by tests on
    /// a machine that can run them. What happens here is clamping to the
    /// protocol's own bounds — a defence against a malformed request, not a
    /// second implementation of the policy.
    public static func parse(_ payload: [String: Any]) -> CaptureConfiguration? {
        guard
            let windowNumber = (payload["windowNumber"] as? NSNumber)?.intValue,
            let width = (payload["width"] as? NSNumber)?.intValue,
            let height = (payload["height"] as? NSNumber)?.intValue,
            let fps = (payload["sampleFps"] as? NSNumber)?.doubleValue,
            windowNumber >= 0,
            width > 0,
            height > 0,
            fps.isFinite
        else {
            return nil
        }

        let encoding = CaptureEncodingKind(rawValue: (payload["encoding"] as? String) ?? "jpeg")
        let quality = (payload["quality"] as? NSNumber)?.doubleValue ?? 0.9
        let clampedFps = min(max(fps, CaptureLimits.minFps), CaptureLimits.maxFps)
        let depth = (payload["queueDepth"] as? NSNumber)?.intValue ?? CaptureLimits.defaultQueueDepth
        let byteLimit =
            (payload["queueByteLimit"] as? NSNumber)?.intValue ?? CaptureLimits.defaultQueueByteLimit
        let interval = max(1, Int((1000.0 / clampedFps).rounded()))
        let resend = (payload["resendUnchangedAfterMs"] as? NSNumber)?.intValue ?? interval
        let maxAge = (payload["maxFrameAgeMs"] as? NSNumber)?.intValue ?? 3000

        return CaptureConfiguration(
            windowNumber: windowNumber,
            width: min(max(1, width), CaptureLimits.maxEdgePixels),
            height: min(max(1, height), CaptureLimits.maxEdgePixels),
            sampleFps: clampedFps,
            includeCursor: (payload["includeCursor"] as? Bool) ?? false,
            encoding: encoding ?? .jpeg,
            quality: min(max(0.1, quality), 1.0),
            queueDepth: min(max(1, depth), CaptureLimits.maxQueueDepth),
            queueByteLimit: max(1, byteLimit),
            resendUnchangedAfterMs: max(1, resend),
            maxFrameAgeMs: max(1, maxAge)
        )
    }
}

/// One encoded frame waiting to be pulled.
///
/// `bytes` is an independent copy of the pixels. The `IOSurface` behind a
/// `CMSampleBuffer` belongs to the stream and is recycled between frames, so
/// retaining it would corrupt every frame already buffered downstream — PR-004
/// requirement 6. Encoding is what makes the copy, and it happens on the
/// stream's own queue before anything is enqueued here.
public struct CaptureFrameRecord {
    public let sequence: Int
    public let windowNumber: Int
    public let capturedAt: Int
    public let timestampFallback: Bool
    public let width: Int
    public let height: Int
    public let scaleFactor: Double
    public let encoding: CaptureEncodingKind
    public let bytes: [UInt8]
    public let contentChanged: Bool

    public init(
        sequence: Int,
        windowNumber: Int,
        capturedAt: Int,
        timestampFallback: Bool,
        width: Int,
        height: Int,
        scaleFactor: Double,
        encoding: CaptureEncodingKind,
        bytes: [UInt8],
        contentChanged: Bool
    ) {
        self.sequence = sequence
        self.windowNumber = windowNumber
        self.capturedAt = capturedAt
        self.timestampFallback = timestampFallback
        self.width = width
        self.height = height
        self.scaleFactor = scaleFactor
        self.encoding = encoding
        self.bytes = bytes
        self.contentChanged = contentChanged
    }

    public func jsonObject(streamId: String) -> [String: Any] {
        [
            "streamId": streamId,
            "sequence": sequence,
            "windowNumber": windowNumber,
            "capturedAt": capturedAt,
            "timestampFallback": timestampFallback,
            "width": width,
            "height": height,
            "scaleFactor": scaleFactor,
            "encoding": encoding.rawValue,
            "byteLength": bytes.count,
            "contentChanged": contentChanged,
        ]
    }
}

/// Bounded hand-off queue between the stream's callback and the request loop.
///
/// The stream produces on its own dispatch queue; `capture.pull` consumes on
/// the single thread that answers every other operation. Both ends go through
/// one lock, and the queue is bounded on frames *and* bytes so a host that
/// stops pulling cannot grow the helper's memory without limit. Overflow drops
/// the **oldest** entry and counts it: the newest picture of the screen is
/// always the one worth keeping.
public final class CaptureQueue {
    private let lock = NSLock()
    private var records: [CaptureFrameRecord] = []
    private var bytes = 0
    private var droppedCount = 0
    private var deliveredCount = 0

    public let depthLimit: Int
    public let byteLimit: Int

    public init(depthLimit: Int, byteLimit: Int) {
        self.depthLimit = max(1, depthLimit)
        self.byteLimit = max(1, byteLimit)
    }

    public var dropped: Int {
        lock.lock()
        defer { lock.unlock() }
        return droppedCount
    }

    public var delivered: Int {
        lock.lock()
        defer { lock.unlock() }
        return deliveredCount
    }

    public var count: Int {
        lock.lock()
        defer { lock.unlock() }
        return records.count
    }

    public var byteCount: Int {
        lock.lock()
        defer { lock.unlock() }
        return bytes
    }

    /// Adds a frame, evicting the oldest until both bounds hold again.
    ///
    /// A zero-byte frame is refused outright: PR-004's ring rejects it as
    /// `empty-bytes`, and a frame with no pixels is not a usable anchor for a
    /// question anyway.
    @discardableResult
    public func enqueue(_ record: CaptureFrameRecord) -> Bool {
        if record.bytes.isEmpty {
            return false
        }
        lock.lock()
        defer { lock.unlock() }
        records.append(record)
        bytes += record.bytes.count
        while records.count > depthLimit || (bytes > byteLimit && records.count > 1) {
            let removed = records.removeFirst()
            bytes -= removed.bytes.count
            droppedCount += 1
        }
        return true
    }

    /// Takes the oldest frame at or after `notBefore`, discarding anything
    /// older and anything past `maxAgeMilliseconds`.
    public func dequeue(notBefore: Int?, now: Int, maxAgeMilliseconds: Int) -> CaptureFrameRecord? {
        lock.lock()
        defer { lock.unlock() }
        while let candidate = records.first {
            let tooOld = now - candidate.capturedAt > maxAgeMilliseconds
            let beforeWatermark = notBefore != nil && candidate.capturedAt < notBefore!
            if tooOld || beforeWatermark {
                records.removeFirst()
                bytes -= candidate.bytes.count
                droppedCount += 1
                continue
            }
            records.removeFirst()
            bytes -= candidate.bytes.count
            deliveredCount += 1
            return candidate
        }
        return nil
    }

    /// Drops everything held. Returns how many frames went.
    @discardableResult
    public func clear() -> Int {
        lock.lock()
        defer { lock.unlock() }
        let discarded = records.count
        records.removeAll()
        bytes = 0
        return discarded
    }
}

/// Presentation timestamp → wall clock, PR-004 requirement 1.
public enum CaptureTimestamp {
    /// Beyond this, the conversion is treated as nonsense rather than trusted.
    public static let maxPlausibleAgeSeconds: Double = 5

    /// Converts a sample buffer's presentation time to milliseconds since the
    /// Unix epoch, using the host clock reading taken at the same moment.
    ///
    /// Returns `fallback: true` when the arithmetic produced something
    /// implausible — a negative age, a huge one, or a non-finite input — in
    /// which case the caller's wall-clock reading is used unchanged. Being a
    /// few milliseconds late is harmless; being on the wrong clock base is not.
    public static func wallClockMilliseconds(
        presentationSeconds: Double,
        hostNowSeconds: Double,
        wallNowMilliseconds: Double
    ) -> (milliseconds: Int, fallback: Bool) {
        guard presentationSeconds.isFinite, hostNowSeconds.isFinite, wallNowMilliseconds.isFinite
        else {
            return (Int(Date().timeIntervalSince1970 * 1000), true)
        }
        let ageSeconds = hostNowSeconds - presentationSeconds
        if !ageSeconds.isFinite || ageSeconds < 0 || ageSeconds > maxPlausibleAgeSeconds {
            return (Int(wallNowMilliseconds.rounded()), true)
        }
        return (Int((wallNowMilliseconds - ageSeconds * 1000).rounded()), false)
    }
}

/// What `capture.start` produced.
///
/// `failureCode` is a `PilotError` code, so a window that has already closed
/// arrives on the host as `window-closed` rather than as a generic capture
/// failure the UI cannot act on.
public struct CaptureStartOutcome {
    public let session: CaptureSessionData?
    public let failure: String?
    public let failureCode: String

    public init(session: CaptureSessionData?, failure: String?, failureCode: String = "capture-failed") {
        self.session = session
        self.failure = failure
        self.failureCode = failureCode
    }
}

public struct CaptureSessionData {
    public let streamId: String
    public let windowNumber: Int
    public let width: Int
    public let height: Int
    public let scaleFactor: Double
    public let sampleFps: Double
    public let encoding: CaptureEncodingKind
    public let startedAt: Int

    public init(
        streamId: String,
        windowNumber: Int,
        width: Int,
        height: Int,
        scaleFactor: Double,
        sampleFps: Double,
        encoding: CaptureEncodingKind,
        startedAt: Int
    ) {
        self.streamId = streamId
        self.windowNumber = windowNumber
        self.width = width
        self.height = height
        self.scaleFactor = scaleFactor
        self.sampleFps = sampleFps
        self.encoding = encoding
        self.startedAt = startedAt
    }

    public var jsonObject: [String: Any] {
        [
            "streamId": streamId,
            "windowNumber": windowNumber,
            "width": width,
            "height": height,
            "scaleFactor": scaleFactor,
            "sampleFps": sampleFps,
            "encoding": encoding.rawValue,
            "startedAt": startedAt,
        ]
    }
}

public struct CaptureStopOutcome {
    public let stopped: Bool
    public let delivered: Int
    public let dropped: Int
    public let discarded: Int

    public init(stopped: Bool, delivered: Int, dropped: Int, discarded: Int) {
        self.stopped = stopped
        self.delivered = delivered
        self.dropped = dropped
        self.discarded = discarded
    }

    public var jsonObject: [String: Any] {
        [
            "stopped": stopped,
            "delivered": delivered,
            "dropped": dropped,
            "discarded": discarded,
        ]
    }
}

public struct CapturePullOutcome {
    public let state: CaptureStreamState
    public let streamId: String?
    public let frame: CaptureFrameRecord?
    public let remaining: Int
    public let dropped: Int
    public let delivered: Int
    public let failure: String?

    public init(
        state: CaptureStreamState,
        streamId: String?,
        frame: CaptureFrameRecord?,
        remaining: Int,
        dropped: Int,
        delivered: Int,
        failure: String?
    ) {
        self.state = state
        self.streamId = streamId
        self.frame = frame
        self.remaining = remaining
        self.dropped = dropped
        self.delivered = delivered
        self.failure = failure
    }

    public var jsonObject: [String: Any] {
        var object: [String: Any] = [
            "state": state.rawValue,
            "frame": NSNull(),
            "remaining": remaining,
            "dropped": dropped,
            "delivered": delivered,
            "failure": JSONValue.orNull(failure),
        ]
        if let frame = frame, let streamId = streamId {
            object["frame"] = frame.jsonObject(streamId: streamId)
        }
        return object
    }
}

/// The capture surface `HelperServer` depends on.
///
/// Injected, like `PermissionService` and `WindowService`, so every operation
/// can be dispatched through the server in `swift test` with no window server,
/// no TCC prompt and no compositor.
public protocol CaptureService {
    func start(_ configuration: CaptureConfiguration) -> CaptureStartOutcome
    func stop(streamId: String?) -> CaptureStopOutcome
    func pull(streamId: String, notBefore: Int?) -> CapturePullOutcome
}
