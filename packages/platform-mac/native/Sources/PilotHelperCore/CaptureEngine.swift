import CoreGraphics
import CoreImage
import CoreMedia
import CoreVideo
import Foundation
import ImageIO
import ScreenCaptureKit

/// The ScreenCaptureKit half of capture (PR-012).
///
/// **Never compiled or run** (runbook amendment 8). As with
/// `PermissionProbes.swift` and `WindowEnumerator.swift`, everything that could
/// be pure was moved into `CaptureModel.swift`, which `swift test` does cover:
/// the request parser and its clamps, the bounded queue and its drop
/// accounting, and the presentation-timestamp conversion. What is left here is
/// the thinnest wrapper the framework allows.
///
/// ## The filter, and why there is only one of them
///
/// ```swift
/// let filter = SCContentFilter(desktopIndependentWindow: window)
/// ```
///
/// That line, once, is the only `SCContentFilter` this package constructs.
/// There is no display initialiser, no "capture the display and crop", and no
/// fallback for a window the compositor no longer lists — a request for a
/// missing window fails as `window-closed`. system-design §14 requires
/// selected-window filters and forbids silently widening to a display, and
/// PR-021's tool description tells the model in as many words that "Pilot never
/// captures the whole display as a substitute". A fallback here would make that
/// a lie, and it would be a privacy breach rather than a bug.
///
/// The window is looked up by exact `windowID` equality. Notably *not*
/// `content.windows.first`: PR-011 hit the same shape in
/// `WindowEnumerator.window(number:)`, where taking the first element of a
/// list-shaped answer produces a wrong window that looks exactly like a right
/// one.
///
/// ## Threading
///
/// The stream delivers on `sampleQueue`; every operation is answered on the
/// helper's single request thread. They meet at `lock` and at `CaptureQueue`,
/// which is itself locked. Nothing here writes to stdout — that would race the
/// request loop for the frame stream — so the callback only ever enqueues, and
/// `capture.pull` drains.
public final class SystemCaptureService: NSObject, CaptureService, SCStreamOutput, SCStreamDelegate
{
    private let lock = NSLock()
    private let sampleQueue = DispatchQueue(label: "com.pilot.helper.capture", qos: .userInitiated)

    /// Built on first use and only ever touched from `sampleQueue`, so merely
    /// constructing the service costs nothing — the helper builds one at
    /// startup whether or not anything is ever captured.
    ///
    /// Software rendering is off: encoding a 1440 px frame on the CPU at 3 FPS
    /// would spend real time in the helper for no benefit. system-design §17
    /// keeps encoding out of the main and renderer processes; it does not ask
    /// for it to be slow here either.
    private lazy var context = CIContext(options: [CIContextOption.useSoftwareRenderer: false])

    private var stream: SCStream?
    private var configuration: CaptureConfiguration?
    private var queue: CaptureQueue?
    private var activeStreamId: String?
    private var state: CaptureStreamState = .stopped
    private var failureText: String?
    private var sequence = 0
    private var blankRun = 0
    private var lastEncoded: [UInt8]?
    private var lastWidth = 0
    private var lastHeight = 0
    private var lastEnqueuedAt = 0
    private var scaleFactor: Double = 1
    private var needsWindowRecheck = false

    /// Bound on how long a framework call may take before it is treated as
    /// hung. ScreenCaptureKit's completion handlers arrive on an internal
    /// queue, so the wait below cannot deadlock against this thread — but a
    /// wait with no timeout would still hang the whole helper if that ever
    /// stopped being true, and a hung helper is indistinguishable from a
    /// crashed one only after the supervisor's deadline expires.
    private static var frameworkTimeout: DispatchTime { .now() + .seconds(5) }

    // MARK: - CaptureService

    public func start(_ requested: CaptureConfiguration) -> CaptureStartOutcome {
        stopActiveStream()

        if SystemWindowService.screenIsLocked() {
            return CaptureStartOutcome(
                session: nil,
                failure: "the screen is locked",
                failureCode: "screen-locked"
            )
        }

        guard let content = shareableContent() else {
            return CaptureStartOutcome(
                session: nil,
                failure: "ScreenCaptureKit did not return shareable content",
                failureCode: "capture-failed"
            )
        }

        let wanted = CGWindowID(requested.windowNumber)
        var selected: SCWindow?
        for candidate in content.windows where candidate.windowID == wanted {
            selected = candidate
            break
        }
        guard let window = selected else {
            // No fallback. Not the frontmost window, not the display the window
            // was on, not the first entry in the list.
            return CaptureStartOutcome(
                session: nil,
                failure: "window \(requested.windowNumber) is not available for capture",
                failureCode: "window-closed"
            )
        }

        let filter = SCContentFilter(desktopIndependentWindow: window)

        let streamConfiguration = SCStreamConfiguration()
        streamConfiguration.width = requested.width
        streamConfiguration.height = requested.height
        streamConfiguration.showsCursor = requested.includeCursor
        streamConfiguration.pixelFormat = kCVPixelFormatType_32BGRA
        streamConfiguration.minimumFrameInterval = CMTime(
            seconds: 1.0 / requested.sampleFps,
            preferredTimescale: 600
        )
        // The framework's own bound is 3…8; the host's queue depth governs the
        // helper-side hand-off queue, not this one.
        streamConfiguration.queueDepth = min(8, max(3, requested.queueDepth))

        let created = SCStream(filter: filter, configuration: streamConfiguration, delegate: self)
        do {
            try created.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        } catch {
            return CaptureStartOutcome(
                session: nil,
                failure: "could not attach a stream output: \(error.localizedDescription)",
                failureCode: "capture-failed"
            )
        }

        let identifier = "cap-\(UUID().uuidString)"
        let windowWidth = Double(window.frame.width)
        let effectiveScale = windowWidth > 0 ? Double(requested.width) / windowWidth : 1

        lock.lock()
        stream = created
        configuration = requested
        queue = CaptureQueue(depthLimit: requested.queueDepth, byteLimit: requested.queueByteLimit)
        activeStreamId = identifier
        state = .starting
        failureText = nil
        sequence = 0
        blankRun = 0
        lastEncoded = nil
        lastEnqueuedAt = 0
        scaleFactor = effectiveScale
        needsWindowRecheck = false
        lock.unlock()

        if let error = startCapture(created) {
            stopActiveStream()
            return CaptureStartOutcome(
                session: nil,
                failure: "could not start the capture stream: \(error.localizedDescription)",
                failureCode: "capture-failed"
            )
        }

        return CaptureStartOutcome(
            session: CaptureSessionData(
                streamId: identifier,
                windowNumber: Int(window.windowID),
                width: requested.width,
                height: requested.height,
                scaleFactor: effectiveScale,
                sampleFps: requested.sampleFps,
                encoding: requested.encoding,
                startedAt: HelperProtocol.now()
            ),
            failure: nil
        )
    }

    public func stop(streamId: String?) -> CaptureStopOutcome {
        lock.lock()
        let active = activeStreamId
        let held = queue
        lock.unlock()

        if active == nil {
            return CaptureStopOutcome(stopped: false, delivered: 0, dropped: 0, discarded: 0)
        }
        if let requested = streamId, requested != active {
            return CaptureStopOutcome(stopped: false, delivered: 0, dropped: 0, discarded: 0)
        }

        let delivered = held?.delivered ?? 0
        let dropped = held?.dropped ?? 0
        let discarded = held?.clear() ?? 0
        stopActiveStream()
        return CaptureStopOutcome(
            stopped: true,
            delivered: delivered,
            dropped: dropped,
            discarded: discarded
        )
    }

    public func pull(streamId: String, notBefore: Int?) -> CapturePullOutcome {
        lock.lock()
        let active = activeStreamId
        let held = queue
        let settings = configuration
        var currentState = state
        let currentFailure = failureText
        let recheck = needsWindowRecheck
        lock.unlock()

        guard let identifier = active, identifier == streamId, let pending = held,
            let settings = settings
        else {
            return CapturePullOutcome(
                state: .stopped,
                streamId: nil,
                frame: nil,
                remaining: 0,
                dropped: 0,
                delivered: 0,
                failure: nil
            )
        }

        // A lock is not a stream error, so the stream never reports it. Check
        // it here, every pull: system-design §14 requires capture to stop while
        // the session is locked, whatever the compositor is still willing to
        // hand over.
        if SystemWindowService.screenIsLocked() {
            lock.lock()
            state = .screenLocked
            lock.unlock()
            pending.clear()
            return CapturePullOutcome(
                state: .screenLocked,
                streamId: identifier,
                frame: nil,
                remaining: 0,
                dropped: pending.dropped,
                delivered: pending.delivered,
                failure: nil
            )
        }

        // A stream that stopped with an error may have stopped because its
        // window went away. Asking the compositor is the only way to tell the
        // two apart, and it is only worth doing once, off the failure path.
        if currentState == .failed && recheck {
            let stillThere = windowExists(settings.windowNumber)
            lock.lock()
            needsWindowRecheck = false
            if !stillThere {
                state = .windowLost
            }
            currentState = state
            lock.unlock()
        }

        let now = HelperProtocol.now()
        let frame = pending.dequeue(
            notBefore: notBefore,
            now: now,
            maxAgeMilliseconds: settings.maxFrameAgeMs
        )
        if frame != nil && currentState == .starting {
            lock.lock()
            state = .streaming
            currentState = .streaming
            lock.unlock()
        }

        return CapturePullOutcome(
            state: currentState,
            streamId: identifier,
            frame: frame,
            remaining: pending.count,
            dropped: pending.dropped,
            delivered: pending.delivered,
            failure: currentFailure
        )
    }

    // MARK: - SCStreamOutput

    public func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of type: SCStreamOutputType
    ) {
        guard type == .screen else {
            return
        }
        lock.lock()
        let settings = configuration
        let held = queue
        lock.unlock()
        guard let settings = settings, let pending = held else {
            return
        }

        switch frameStatus(of: sampleBuffer) {
        case .complete:
            handleComplete(sampleBuffer, settings: settings, queue: pending)
        case .blank:
            handleBlank()
        case .stopped:
            lock.lock()
            state = .stopped
            lock.unlock()
        default:
            // `.idle`, `.suspended`, `.started`: the compositor has nothing new.
            handleUnchanged(settings: settings, queue: pending)
        }
    }

    // MARK: - SCStreamDelegate

    public func stream(_ stream: SCStream, didStopWithError error: Error) {
        lock.lock()
        state = .failed
        failureText = "the capture stream stopped: \(error.localizedDescription)"
        needsWindowRecheck = true
        lock.unlock()
    }

    // MARK: - Frame handling

    private func handleComplete(
        _ sampleBuffer: CMSampleBuffer,
        settings: CaptureConfiguration,
        queue pending: CaptureQueue
    ) {
        guard let imageBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else {
            return
        }
        guard let encoded = encode(imageBuffer, settings: settings), !encoded.isEmpty else {
            // An encoder that produced nothing is a failure, not a frame. A
            // zero-length frame is rejected downstream as `empty-bytes`, so it
            // never leaves this process.
            return
        }

        let width = CVPixelBufferGetWidth(imageBuffer)
        let height = CVPixelBufferGetHeight(imageBuffer)
        let stamp = timestamp(of: sampleBuffer)

        lock.lock()
        sequence += 1
        let next = sequence
        blankRun = 0
        lastEncoded = encoded
        lastWidth = width
        lastHeight = height
        lastEnqueuedAt = stamp.milliseconds
        let scale = scaleFactor
        if state == .starting || state == .protectedContent {
            state = .streaming
        }
        lock.unlock()

        pending.enqueue(
            CaptureFrameRecord(
                sequence: next,
                windowNumber: settings.windowNumber,
                capturedAt: stamp.milliseconds,
                timestampFallback: stamp.fallback,
                width: width,
                height: height,
                scaleFactor: scale,
                encoding: settings.encoding,
                bytes: encoded,
                contentChanged: true
            )
        )
    }

    /// A window that keeps handing back blank frames is blocking capture.
    ///
    /// system-design §16 requires this to be explained rather than delivered: a
    /// black rectangle described to a model as the application's content is a
    /// confident wrong answer, which is worse than a reported failure.
    private func handleBlank() {
        lock.lock()
        blankRun += 1
        if blankRun >= CaptureLimits.blankFramesBeforeProtected {
            state = .protectedContent
        }
        lock.unlock()
    }

    /// Re-sends the retained encoding when the window has not changed.
    ///
    /// ScreenCaptureKit produces pixels only when something moves, so a user
    /// reading a motionless page would fill the ring once and then let it age
    /// out, leaving nothing to answer a question with. The re-send keeps the
    /// three-second ring populated at the sample cadence and costs no new
    /// encoding — the same bytes, a new instant, a new sequence number.
    private func handleUnchanged(settings: CaptureConfiguration, queue pending: CaptureQueue) {
        let now = HelperProtocol.now()
        lock.lock()
        guard let retained = lastEncoded, now - lastEnqueuedAt >= settings.resendUnchangedAfterMs
        else {
            lock.unlock()
            return
        }
        sequence += 1
        let next = sequence
        blankRun = 0
        lastEnqueuedAt = now
        let width = lastWidth
        let height = lastHeight
        let scale = scaleFactor
        if state == .starting {
            state = .streaming
        }
        lock.unlock()

        pending.enqueue(
            CaptureFrameRecord(
                sequence: next,
                windowNumber: settings.windowNumber,
                capturedAt: now,
                timestampFallback: false,
                width: width,
                height: height,
                scaleFactor: scale,
                encoding: settings.encoding,
                bytes: retained,
                contentChanged: false
            )
        )
    }

    private func frameStatus(of sampleBuffer: CMSampleBuffer) -> SCFrameStatus {
        guard
            let attachments = CMSampleBufferGetSampleAttachmentsArray(
                sampleBuffer,
                createIfNecessary: false
            ) as? [[SCStreamFrameInfo: Any]],
            let first = attachments.first,
            let raw = first[SCStreamFrameInfo.status] as? Int,
            let status = SCFrameStatus(rawValue: raw)
        else {
            return .idle
        }
        return status
    }

    /// PR-004 requirement 1: the epoch base, converted before the frame leaves.
    private func timestamp(of sampleBuffer: CMSampleBuffer) -> (milliseconds: Int, fallback: Bool) {
        let presentation = CMSampleBufferGetPresentationTimeStamp(sampleBuffer)
        let hostNow = CMClockGetTime(CMClockGetHostTimeClock())
        return CaptureTimestamp.wallClockMilliseconds(
            presentationSeconds: CMTimeGetSeconds(presentation),
            hostNowSeconds: CMTimeGetSeconds(hostNow),
            wallNowMilliseconds: Date().timeIntervalSince1970 * 1000
        )
    }

    /// Encodes into a standalone byte array.
    ///
    /// PR-004 requirement 6: the `IOSurface` behind the sample buffer belongs to
    /// the stream and is recycled between frames. Encoding copies the pixels out
    /// into memory this process owns, so a frame already handed to the host
    /// cannot be rewritten under it.
    private func encode(_ buffer: CVImageBuffer, settings: CaptureConfiguration) -> [UInt8]? {
        let image = CIImage(cvImageBuffer: buffer)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        var data: Data?
        switch settings.encoding {
        case .jpeg:
            let key = CIImageRepresentationOption(
                rawValue: kCGImageDestinationLossyCompressionQuality as String
            )
            data = context.jpegRepresentation(
                of: image,
                colorSpace: colorSpace,
                options: [key: settings.quality]
            )
        case .png:
            data = context.pngRepresentation(
                of: image,
                format: CIFormat.RGBA8,
                colorSpace: colorSpace,
                options: [:]
            )
        }
        guard let encoded = data else {
            return nil
        }
        return [UInt8](encoded)
    }

    // MARK: - Framework bridging

    /// Synchronous wrapper over the shareable-content query.
    ///
    /// The helper's request loop is synchronous by design (PR-003), so the
    /// completion handler is bridged with a semaphore. The wait is bounded:
    /// ScreenCaptureKit calls back on its own queue rather than the caller's,
    /// so this cannot deadlock, but a bounded wait fails as a typed capture
    /// error instead of hanging the helper if that ever changes.
    private func shareableContent() -> SCShareableContent? {
        let semaphore = DispatchSemaphore(value: 0)
        var result: SCShareableContent?
        SCShareableContent.getExcludingDesktopWindows(
            true,
            onScreenWindowsOnly: false
        ) { content, _ in
            result = content
            semaphore.signal()
        }
        if semaphore.wait(timeout: SystemCaptureService.frameworkTimeout) == .timedOut {
            return nil
        }
        return result
    }

    private func startCapture(_ target: SCStream) -> Error? {
        let semaphore = DispatchSemaphore(value: 0)
        var failure: Error?
        target.startCapture { error in
            failure = error
            semaphore.signal()
        }
        if semaphore.wait(timeout: SystemCaptureService.frameworkTimeout) == .timedOut {
            return NSError(
                domain: "com.pilot.helper.capture",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "startCapture did not answer"]
            )
        }
        return failure
    }

    private func windowExists(_ windowNumber: Int) -> Bool {
        guard let content = shareableContent() else {
            return true  // Unknown is not evidence of absence.
        }
        let wanted = CGWindowID(windowNumber)
        for candidate in content.windows where candidate.windowID == wanted {
            return true
        }
        return false
    }

    private func stopActiveStream() {
        lock.lock()
        let running = stream
        stream = nil
        activeStreamId = nil
        configuration = nil
        queue = nil
        state = .stopped
        failureText = nil
        sequence = 0
        blankRun = 0
        lastEncoded = nil
        lastEnqueuedAt = 0
        needsWindowRecheck = false
        lock.unlock()

        guard let target = running else {
            return
        }
        let semaphore = DispatchSemaphore(value: 0)
        target.stopCapture { _ in
            semaphore.signal()
        }
        _ = semaphore.wait(timeout: SystemCaptureService.frameworkTimeout)
    }
}
