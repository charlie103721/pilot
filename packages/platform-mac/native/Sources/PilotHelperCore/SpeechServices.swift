import AVFoundation
import Foundation
import Speech

/// The framework-touching half of speech: Apple Speech, `AVAudioEngine` and
/// `AVSpeechSynthesizer`.
///
/// **None of this file has ever been compiled or run** (runbook amendment 8).
/// Like `PermissionProbes.swift` it is written to be conservative rather than
/// clever: no async/await, no generics, no Combine, one framework call per
/// step, and every failure degrading to a typed value rather than a trap.
/// Everything expressible as pure logic was moved to `SpeechModel.swift`,
/// which the XCTest target does cover.
///
/// ## Three rules this file exists to keep
///
/// 1. **Audio never leaves this process.** Microphone buffers go from the
///    `AVAudioEngine` tap straight into `SFSpeechAudioBufferRecognitionRequest`
///    and nowhere else. Nothing here opens a file, and no speech operation has
///    a binary body, so there is no path from a buffer to the host, to disk or
///    to a log line (system-design §13, §14).
/// 2. **Nothing waits on the main thread.** `HelperRuntime.run` blocks the main
///    thread in `read()` for the life of the process, so a callback delivered
///    on the main queue would never run. `SFSpeechRecognizer.queue` is
///    therefore set to a queue this file owns, the audio tap already runs on a
///    real-time audio thread, and the synthesiser's completion is additionally
///    reconciled from `isSpeaking` at poll time so a delegate that *does* want
///    the main queue cannot strand an utterance forever.
/// 3. **One ending per utterance.** `SFSpeechRecognitionTask` can report a
///    second `isFinal`, and can call its handler after `cancel()`;
///    `AVSpeechSynthesizer` can be observed to have stopped by both its
///    delegate and the reconciliation above. `SpeechTerminalLedger` makes the
///    second notification a no-op rather than a duplicate event.
///
/// The protocols exist so `HelperServer` can be driven by stubs in tests, the
/// same arrangement `PermissionService` and `WindowService` use.

// ---------------------------------------------------------------------------
// Protocols
// ---------------------------------------------------------------------------

public struct SpeechInputAvailabilityReport {
    public let facts: SpeechRecognizerFacts
    public let microphone: PermissionState
    public let speechRecognition: PermissionState

    public init(
        facts: SpeechRecognizerFacts,
        microphone: PermissionState,
        speechRecognition: PermissionState
    ) {
        self.facts = facts
        self.microphone = microphone
        self.speechRecognition = speechRecognition
    }

    public var jsonObject: [String: Any] {
        [
            "facts": facts.jsonObject,
            "microphone": microphone.rawValue,
            "speechRecognition": speechRecognition.rawValue,
        ]
    }
}

public struct SpeechStartOutcome {
    public let onDevice: Bool
    public let locale: String?

    public init(onDevice: Bool, locale: String?) {
        self.onDevice = onDevice
        self.locale = locale
    }

    public var jsonObject: [String: Any] {
        ["started": true, "onDevice": onDevice, "locale": JSONValue.orNull(locale)]
    }
}

public protocol SpeechInputService {
    func availability(locale: String?) -> SpeechInputAvailabilityReport
    /// `onDevice` is the host's decision, not a hint. Throws rather than
    /// quietly recognising remotely when it cannot be honoured.
    func start(utteranceId: String, onDevice: Bool, locale: String?) throws -> SpeechStartOutcome
    /// Ends capture. `false` means this utterance was not the one recording,
    /// which is a normal outcome and never an error.
    func stop(utteranceId: String) -> Bool
    /// Ends capture and discards the utterance. Same idempotence rule.
    func cancel(utteranceId: String) -> Bool
    func poll(since: Int) -> SpeechPollSnapshot
}

public protocol SpeechOutputService {
    func availability() -> (available: Bool, voices: [SpeechVoiceDescription])
    /// Returns true when something was already speaking and this joined the queue.
    func speak(speechId: String, text: String, voice: String?, rate: Double?) throws -> Bool
    /// Stops speech and returns every utterance that was discarded.
    func stop(speechId: String?) -> [String]
    func poll(since: Int) -> SpeechPollSnapshot
}

// ---------------------------------------------------------------------------
// Speech input
// ---------------------------------------------------------------------------

public final class SystemSpeechInputService: SpeechInputService {
    private let lock = NSLock()
    private let queue: SpeechEventQueue
    private let ledger: SpeechTerminalLedger

    /// Where recognition callbacks are delivered.
    ///
    /// Explicitly **not** the main queue: the helper's main thread is blocked
    /// in the stdio read loop and runs no run loop, so a main-queue callback
    /// would never fire and recognition would appear to hang forever. One
    /// concurrent operation, so results stay in order.
    private let callbackQueue: OperationQueue

    private var recognizer: SFSpeechRecognizer?
    private var engine: AVAudioEngine?
    private var request: SFSpeechAudioBufferRecognitionRequest?
    private var task: SFSpeechRecognitionTask?
    private var activeUtteranceId: String?
    private var capturing = false

    public init(queueCapacity: Int = 256) {
        self.queue = SpeechEventQueue(capacity: queueCapacity)
        self.ledger = SpeechTerminalLedger(capacity: 32)
        let operations = OperationQueue()
        operations.maxConcurrentOperationCount = 1
        operations.name = "pilot.speech.recognition"
        self.callbackQueue = operations
    }

    // MARK: - Availability

    public func availability(locale: String?) -> SpeechInputAvailabilityReport {
        let microphone = PermissionStateMapper.fromCaptureAuthorization(
            Int(AVCaptureDevice.authorizationStatus(for: .audio).rawValue)
        )
        let speech = PermissionStateMapper.fromSpeechAuthorization(
            Int(SFSpeechRecognizer.authorizationStatus().rawValue)
        )

        var supported = SFSpeechRecognizer.supportedLocales().map { $0.identifier }
        supported.sort()
        if supported.count > 200 {
            supported = Array(supported.prefix(200))
        }

        guard let recognizer = makeRecognizer(locale: locale) else {
            return SpeechInputAvailabilityReport(
                facts: SpeechRecognizerFacts(
                    recognizerAvailable: false,
                    supportsOnDevice: false,
                    locale: nil,
                    supportedLocales: supported,
                    recognizerOffline: false
                ),
                microphone: microphone,
                speechRecognition: speech
            )
        }

        return SpeechInputAvailabilityReport(
            facts: SpeechRecognizerFacts(
                recognizerAvailable: recognizer.isAvailable,
                supportsOnDevice: recognizer.supportsOnDeviceRecognition,
                locale: recognizer.locale.identifier,
                supportedLocales: supported,
                recognizerOffline: !recognizer.isAvailable
            ),
            microphone: microphone,
            speechRecognition: speech
        )
    }

    // MARK: - Capture

    public func start(
        utteranceId: String,
        onDevice: Bool,
        locale: String?
    ) throws -> SpeechStartOutcome {
        // Permissions are only *read* here; raising the prompt belongs to
        // PR-011's `permissions.request`. Microphone and Speech Recognition
        // are separate grants and their authorization enums disagree on their
        // raw values, so each goes through its own mapper.
        let microphone = PermissionStateMapper.fromCaptureAuthorization(
            Int(AVCaptureDevice.authorizationStatus(for: .audio).rawValue)
        )
        guard microphone == .granted else {
            throw SpeechServiceError(
                code: .permissionDenied,
                message: "Microphone permission is \(microphone.rawValue)"
            )
        }
        let speech = PermissionStateMapper.fromSpeechAuthorization(
            Int(SFSpeechRecognizer.authorizationStatus().rawValue)
        )
        guard speech == .granted else {
            throw SpeechServiceError(
                code: .permissionDenied,
                message: "Speech Recognition permission is \(speech.rawValue)"
            )
        }

        // Exactly one recogniser at a time, whatever the host did last.
        teardown(cancelTask: true)

        guard let recognizer = makeRecognizer(locale: locale) else {
            throw SpeechServiceError(
                code: .recognizerUnavailable,
                message: "No speech recogniser for the requested locale"
            )
        }
        guard recognizer.isAvailable else {
            throw SpeechServiceError(
                code: .recognizerUnavailable,
                message: "The speech recogniser is not available right now"
            )
        }
        if onDevice && !recognizer.supportsOnDeviceRecognition {
            // The host already decided this could not happen; refusing again
            // here means a host bug cannot turn into audio leaving the Mac.
            throw SpeechServiceError(
                code: .onDeviceUnavailable,
                message: "On-device recognition is unavailable for this locale"
            )
        }
        recognizer.queue = callbackQueue

        let recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        recognitionRequest.shouldReportPartialResults = true
        // The only real guarantee available: with this set, recognition fails
        // rather than sending the recording to Apple.
        recognitionRequest.requiresOnDeviceRecognition = onDevice
        recognitionRequest.addsPunctuation = true
        recognitionRequest.taskHint = .dictation

        let audioEngine = AVAudioEngine()
        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        guard format.sampleRate > 0, format.channelCount > 0 else {
            throw SpeechServiceError(
                code: .audioEngine,
                message: "No usable audio input device"
            )
        }
        inputNode.installTap(onBus: 0, bufferSize: 2048, format: format) { buffer, _ in
            // The one and only destination of microphone audio in Pilot.
            recognitionRequest.append(buffer)
        }
        audioEngine.prepare()
        do {
            try audioEngine.start()
        } catch {
            inputNode.removeTap(onBus: 0)
            throw SpeechServiceError(
                code: .audioEngine,
                message: "Could not start the audio engine: \(error.localizedDescription)"
            )
        }

        let recognitionTask = recognizer.recognitionTask(with: recognitionRequest) {
            [weak self] result, error in
            self?.handle(utteranceId: utteranceId, result: result, error: error)
        }

        lock.lock()
        self.recognizer = recognizer
        self.engine = audioEngine
        self.request = recognitionRequest
        self.task = recognitionTask
        self.activeUtteranceId = utteranceId
        self.capturing = true
        lock.unlock()

        return SpeechStartOutcome(onDevice: onDevice, locale: recognizer.locale.identifier)
    }

    public func stop(utteranceId: String) -> Bool {
        lock.lock()
        guard activeUtteranceId == utteranceId, capturing else {
            lock.unlock()
            return false
        }
        let pendingRequest = request
        lock.unlock()

        // Release the microphone immediately — the user let go of the key —
        // but keep the task alive so the transcript still arrives.
        releaseMicrophone()
        pendingRequest?.endAudio()
        return true
    }

    public func cancel(utteranceId: String) -> Bool {
        lock.lock()
        let known = activeUtteranceId == utteranceId
        lock.unlock()
        guard known else {
            return false
        }
        // Marked ended before teardown so the task's own cancellation callback
        // cannot enqueue anything for an utterance that is being discarded.
        _ = ledger.markEnded(utteranceId)
        teardown(cancelTask: true)
        return true
    }

    public func poll(since: Int) -> SpeechPollSnapshot {
        lock.lock()
        let active = activeUtteranceId
        let recording = capturing
        lock.unlock()
        return SpeechPollSnapshot(
            drain: queue.drain(since: since),
            active: recording,
            activeIdentifier: active
        )
    }

    // MARK: - Callbacks

    private func handle(
        utteranceId: String,
        result: SFSpeechRecognitionResult?,
        error: Error?
    ) {
        lock.lock()
        let isActive = activeUtteranceId == utteranceId
        lock.unlock()
        // Anything about an utterance that is over — a late callback after
        // cancel, a second final — stops here.
        guard isActive, !ledger.hasEnded(utteranceId) else {
            return
        }

        if let result = result {
            let transcript = result.bestTranscription.formattedString
            if result.isFinal {
                if ledger.markEnded(utteranceId) {
                    queue.append(
                        SpeechEventBody.final(utteranceId: utteranceId, transcript: transcript)
                    )
                }
                // A recogniser is allowed to endpoint before push-to-talk is
                // released. Release the microphone here rather than waiting
                // for a `stop` that may never come — and the `stop` that does
                // come is then a no-op, which is exactly the contract.
                teardown(cancelTask: false)
                return
            }
            queue.append(SpeechEventBody.partial(utteranceId: utteranceId, transcript: transcript))
            return
        }

        if let error = error {
            let nsError = error as NSError
            let code = SpeechErrorMapper.classify(nsError)
            if ledger.markEnded(utteranceId) {
                queue.append(
                    SpeechEventBody.inputError(
                        utteranceId: utteranceId,
                        code: code,
                        // `localizedDescription` only. Never the transcript,
                        // and never anything derived from the audio.
                        message: nsError.localizedDescription
                    )
                )
            }
            teardown(cancelTask: false)
        }
    }

    // MARK: - Teardown

    private func makeRecognizer(locale: String?) -> SFSpeechRecognizer? {
        guard let locale = locale, !locale.isEmpty else {
            return SFSpeechRecognizer()
        }
        return SFSpeechRecognizer(locale: Locale(identifier: locale))
    }

    /// Stops capture and frees the microphone. Idempotent.
    private func releaseMicrophone() {
        lock.lock()
        let audioEngine = engine
        engine = nil
        capturing = false
        lock.unlock()

        guard let audioEngine = audioEngine else {
            return
        }
        audioEngine.inputNode.removeTap(onBus: 0)
        audioEngine.stop()
    }

    /// Releases everything for the current utterance. Idempotent, and safe to
    /// call from a recognition callback as well as from the request loop.
    private func teardown(cancelTask: Bool) {
        lock.lock()
        let audioEngine = engine
        let pendingRequest = request
        let pendingTask = task
        engine = nil
        request = nil
        task = nil
        recognizer = nil
        activeUtteranceId = nil
        capturing = false
        lock.unlock()

        if let audioEngine = audioEngine {
            audioEngine.inputNode.removeTap(onBus: 0)
            audioEngine.stop()
        }
        pendingRequest?.endAudio()
        if cancelTask {
            pendingTask?.cancel()
        }
    }
}

// ---------------------------------------------------------------------------
// Speech output
// ---------------------------------------------------------------------------

public final class SystemSpeechOutputService: NSObject, SpeechOutputService,
    AVSpeechSynthesizerDelegate
{
    /// Consecutive polls that must see the synthesiser idle before the
    /// reconciliation below declares the queue drained.
    ///
    /// One is not enough: `speak()` returns before audio necessarily begins,
    /// and a single early poll could otherwise end an utterance that is about
    /// to start. Two polls cost at most one extra interval, and only on the
    /// path where the delegate never fired at all.
    public static let idlePollsBeforeReconcile = 2

    private let synthesizer = AVSpeechSynthesizer()
    private let lock = NSLock()
    private let queue: SpeechEventQueue
    private let ledger: SpeechTerminalLedger

    private var pending: [(id: String, utterance: AVSpeechUtterance)] = []
    /// Recently spoken utterances, so a delegate callback that arrives after
    /// the queue was flushed can still be identified.
    private var history: [(id: String, utterance: AVSpeechUtterance)] = []
    private var startedIds: [String] = []
    private var sawSpeaking = false
    private var idlePolls = 0

    public override init() {
        self.queue = SpeechEventQueue(capacity: 256)
        self.ledger = SpeechTerminalLedger(capacity: 32)
        super.init()
        synthesizer.delegate = self
    }

    // MARK: - Availability

    public func availability() -> (available: Bool, voices: [SpeechVoiceDescription]) {
        let voices = AVSpeechSynthesisVoice.speechVoices().map { voice in
            SpeechVoiceDescription(
                identifier: voice.identifier,
                name: voice.name,
                language: voice.language,
                quality: SystemSpeechOutputService.describe(voice.quality)
            )
        }
        return (available: !voices.isEmpty, voices: voices)
    }

    /// Quality by raw value rather than by case, so a future quality this SDK
    /// does not know reads as `unknown` instead of failing to compile.
    private static func describe(_ quality: AVSpeechSynthesisVoiceQuality) -> String {
        switch quality.rawValue {
        case 1: return "default"
        case 2: return "enhanced"
        case 3: return "premium"
        default: return "unknown"
        }
    }

    // MARK: - Speaking

    public func speak(speechId: String, text: String, voice: String?, rate: Double?) throws -> Bool {
        guard !AVSpeechSynthesisVoice.speechVoices().isEmpty else {
            throw SpeechServiceError(
                code: .voiceUnavailable,
                message: "No speech synthesis voice is installed"
            )
        }

        let utterance = AVSpeechUtterance(string: text)
        if let resolved = resolveVoice(voice) {
            utterance.voice = resolved
        }
        utterance.rate = Float(
            SpeechRateMapper.platformRate(
                fraction: rate,
                minimum: Double(AVSpeechUtteranceMinimumSpeechRate),
                maximum: Double(AVSpeechUtteranceMaximumSpeechRate),
                fallback: Double(AVSpeechUtteranceDefaultSpeechRate)
            )
        )

        lock.lock()
        let queued = !pending.isEmpty
        pending.append((id: speechId, utterance: utterance))
        history.append((id: speechId, utterance: utterance))
        while history.count > 32 {
            history.removeFirst()
        }
        sawSpeaking = true
        idlePolls = 0
        lock.unlock()

        // `AVSpeechSynthesizer` owns the queue: a second `speak` while the
        // first is playing joins it rather than interrupting it, which is what
        // makes sentence-by-sentence playback gapless without the host timing
        // anything.
        synthesizer.speak(utterance)
        return queued
    }

    public func stop(speechId: String?) -> [String] {
        lock.lock()
        if let speechId = speechId, !pending.contains(where: { $0.id == speechId }) {
            lock.unlock()
            return []
        }
        let discarded = pending.map { $0.id }
        pending.removeAll()
        sawSpeaking = false
        idlePolls = 0
        lock.unlock()

        guard !discarded.isEmpty else {
            return []
        }
        // There is no API to remove one entry from the synthesiser's queue, so
        // stopping any utterance stops all of them. Every discarded id is
        // returned, so the host can report each one rather than leaving a
        // caller waiting on a chunk that will never be spoken.
        synthesizer.stopSpeaking(at: .immediate)
        for identifier in discarded {
            _ = ledger.markEnded(identifier)
        }
        return discarded
    }

    public func poll(since: Int) -> SpeechPollSnapshot {
        reconcile()
        lock.lock()
        let active = pending.first?.id
        lock.unlock()
        return SpeechPollSnapshot(
            drain: queue.drain(since: since),
            active: synthesizer.isSpeaking,
            activeIdentifier: active
        )
    }

    // MARK: - Delegate

    public func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didStart utterance: AVSpeechUtterance
    ) {
        guard let identifier = identify(utterance) else {
            return
        }
        markStarted(identifier)
    }

    public func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didFinish utterance: AVSpeechUtterance
    ) {
        end(utterance: utterance, stopped: false)
    }

    public func speechSynthesizer(
        _ synthesizer: AVSpeechSynthesizer,
        didCancel utterance: AVSpeechUtterance
    ) {
        end(utterance: utterance, stopped: true)
    }

    // MARK: - Internals

    private func resolveVoice(_ requested: String?) -> AVSpeechSynthesisVoice? {
        guard let requested = requested, !requested.isEmpty else {
            return nil
        }
        if let byIdentifier = AVSpeechSynthesisVoice(identifier: requested) {
            return byIdentifier
        }
        return AVSpeechSynthesisVoice(language: requested)
    }

    private func identify(_ utterance: AVSpeechUtterance) -> String? {
        lock.lock()
        defer { lock.unlock() }
        return history.first(where: { $0.utterance === utterance })?.id
    }

    /// Emits `started` once, whichever path notices it first.
    private func markStarted(_ identifier: String) {
        lock.lock()
        let isNew = !startedIds.contains(identifier)
        if isNew {
            startedIds.append(identifier)
            while startedIds.count > 32 {
                startedIds.removeFirst()
            }
        }
        lock.unlock()
        if isNew {
            queue.append(SpeechEventBody.started(speechId: identifier))
        }
    }

    private func end(utterance: AVSpeechUtterance, stopped: Bool) {
        guard let identifier = identify(utterance) else {
            return
        }
        lock.lock()
        pending.removeAll { $0.id == identifier }
        lock.unlock()

        guard ledger.markEnded(identifier) else {
            return
        }
        // Keep the order a consumer expects even when the start callback never
        // arrived: nothing may finish without having started.
        markStarted(identifier)
        queue.append(
            stopped
                ? SpeechEventBody.stopped(speechId: identifier)
                : SpeechEventBody.finished(speechId: identifier)
        )
    }

    /// Ends utterances the delegate never reported.
    ///
    /// `AVSpeechSynthesizerDelegate` callbacks may want a run loop the helper's
    /// blocked main thread does not provide. `isSpeaking` is a property and
    /// needs no callback at all, so a queue that has gone quiet is detected
    /// here regardless. When the delegate *does* work this loop finds nothing
    /// to do, because the ledger has already ended everything.
    private func reconcile() {
        if synthesizer.isSpeaking || synthesizer.isPaused {
            lock.lock()
            sawSpeaking = true
            idlePolls = 0
            lock.unlock()
            return
        }

        lock.lock()
        guard sawSpeaking, !pending.isEmpty else {
            lock.unlock()
            return
        }
        idlePolls += 1
        guard idlePolls >= SystemSpeechOutputService.idlePollsBeforeReconcile else {
            lock.unlock()
            return
        }
        let orphans = pending.map { $0.id }
        pending.removeAll()
        sawSpeaking = false
        idlePolls = 0
        lock.unlock()

        for identifier in orphans {
            guard ledger.markEnded(identifier) else {
                continue
            }
            markStarted(identifier)
            queue.append(SpeechEventBody.finished(speechId: identifier))
        }
    }
}
