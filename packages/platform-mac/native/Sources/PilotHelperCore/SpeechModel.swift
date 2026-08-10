import Foundation

/// Speech vocabulary, event queueing and error classification, with **no
/// framework imports**.
///
/// Same split as `PermissionModel.swift`: everything that can be a pure
/// function of its arguments lives here, where `swift test` proves it, and the
/// calls that touch Speech, AVFoundation and the microphone live in
/// `SpeechServices.swift` behind protocols the tests substitute.
///
/// Mirrors `packages/platform-mac/src/protocol/speech-ops.ts`.

// ---------------------------------------------------------------------------
// Failure vocabulary
// ---------------------------------------------------------------------------

/// Why recognition or synthesis failed.
///
/// Kept in exact agreement with `SPEECH_FAILURE_CODES` on the host. The host
/// maps these onto `PilotError` codes; the helper never invents an error code
/// of its own, so a failure Pilot has never seen before still arrives as
/// something the UI knows how to render.
public enum SpeechFailureCode: String {
    case noSpeech = "no-speech"
    case audioEngine = "audio-engine"
    case recognizerFailed = "recognizer-failed"
    case recognizerUnavailable = "recognizer-unavailable"
    case onDeviceUnavailable = "on-device-unavailable"
    case permissionDenied = "permission-denied"
    case synthesisFailed = "synthesis-failed"
    case voiceUnavailable = "voice-unavailable"
    case cancelled = "cancelled"
    case interalUnclassified = "internal"
}

/// A failure the helper reports in place of a response.
public struct SpeechServiceError: Error {
    public let code: SpeechFailureCode
    public let message: String

    public init(code: SpeechFailureCode, message: String) {
        self.code = code
        self.message = message
    }
}

/// Turns a platform `NSError` into the closed vocabulary above.
///
/// **The numbers below are folklore.** Apple documents neither
/// `kAFAssistantErrorDomain` nor its codes; they are what the community has
/// observed, and none of it has been checked on a Mac by this project
/// (runbook amendment 8). That is precisely why the classification lives in
/// one small pure function:
///
/// - A wrong guess degrades to `recognizerFailed`, which is still a correct,
///   typed, user-actionable failure — never a crash and never silence.
/// - Correcting a guess is a one-line change here plus one test, with no
///   effect on the wire format or on any host behaviour.
///
/// Anything unrecognised is `recognizerFailed` rather than `internal`, because
/// a recognition attempt that failed *is* a recognition failure whatever the
/// number says; `internal` is reserved for the helper's own bugs.
public enum SpeechErrorMapper {
    public static let assistantErrorDomain = "kAFAssistantErrorDomain"
    public static let speechErrorDomain = "com.apple.speech.recognition.error"

    /// Reported when the recogniser heard nothing it could use.
    public static let noSpeechCodes: Set<Int> = [203, 1110]
    /// Reported when local recognition is switched off or unavailable.
    public static let localUnavailableCodes: Set<Int> = [1101, 1107]
    /// Reported when the user (or Pilot) cancelled the task.
    public static let cancellationCodes: Set<Int> = [216, 301, 3072]

    public static func classify(domain: String, code: Int) -> SpeechFailureCode {
        if code == NSUserCancelledError || cancellationCodes.contains(code) {
            return .cancelled
        }
        if domain == assistantErrorDomain || domain == speechErrorDomain {
            if noSpeechCodes.contains(code) {
                return .noSpeech
            }
            if localUnavailableCodes.contains(code) {
                return .onDeviceUnavailable
            }
            return .recognizerFailed
        }
        if domain == NSURLErrorDomain {
            // Recognition that needed the network and did not get it. Only
            // reachable when the audio was going to leave the Mac anyway.
            return .recognizerUnavailable
        }
        return .recognizerFailed
    }

    public static func classify(_ error: NSError) -> SpeechFailureCode {
        classify(domain: error.domain, code: error.code)
    }
}

// ---------------------------------------------------------------------------
// Event queue
// ---------------------------------------------------------------------------

/// One queued event: a sequence number and the JSON body the host will parse.
public struct SpeechEvent {
    public let sequence: Int
    public let body: [String: Any]

    public init(sequence: Int, body: [String: Any]) {
        self.sequence = sequence
        self.body = body
    }

    /// The body with its sequence number attached, ready to serialise.
    public var jsonObject: [String: Any] {
        var object = body
        object["sequence"] = sequence
        return object
    }
}

/// What one drain produced.
public struct SpeechDrain {
    public let events: [SpeechEvent]
    /// Highest sequence the queue has ever issued.
    public let sequence: Int
    /// Cumulative events discarded because the ring was full.
    public let dropped: Int

    public init(events: [SpeechEvent], sequence: Int, dropped: Int) {
        self.events = events
        self.sequence = sequence
        self.dropped = dropped
    }
}

/// A bounded, lock-protected queue of events waiting to be collected.
///
/// Recognition and synthesis callbacks arrive on threads the helper does not
/// own, and the stdio request loop runs on another one. Rather than have those
/// threads write frames — a second writer on the same pipe, which PR-011
/// declined to introduce for window events and this PR declines for the same
/// reason — they append here and the host collects with a poll.
///
/// `drain(since:)` is idempotent: it returns everything above `since` and
/// discards only what the host has demonstrably seen. A poll whose response
/// was lost to a deadline can simply be repeated.
///
/// When the ring is full the **oldest** event is dropped and counted. That is
/// the right direction: the oldest event of an overflowing queue is a stale
/// partial hypothesis, while the newest is the final transcript.
public final class SpeechEventQueue {
    private let lock = NSLock()
    private let capacity: Int
    private var events: [SpeechEvent] = []
    private var lastSequence = 0
    private var droppedCount = 0

    public init(capacity: Int = 256) {
        self.capacity = max(1, capacity)
    }

    /// Appends an event and returns its sequence number.
    @discardableResult
    public func append(_ body: [String: Any]) -> Int {
        lock.lock()
        defer { lock.unlock() }
        lastSequence += 1
        events.append(SpeechEvent(sequence: lastSequence, body: body))
        while events.count > capacity {
            events.removeFirst()
            droppedCount += 1
        }
        return lastSequence
    }

    /// Everything issued after `since`. Acknowledged entries are released.
    public func drain(since: Int) -> SpeechDrain {
        lock.lock()
        defer { lock.unlock() }
        events.removeAll { $0.sequence <= since }
        return SpeechDrain(events: events, sequence: lastSequence, dropped: droppedCount)
    }

    /// Discards everything queued. Used when a session is torn down.
    public func clear() {
        lock.lock()
        defer { lock.unlock() }
        events.removeAll()
    }
}

// ---------------------------------------------------------------------------
// Terminal ledger
// ---------------------------------------------------------------------------

/// Remembers which utterances have already ended, so none ends twice.
///
/// `SFSpeechRecognitionTask` can deliver a second `isFinal` result, and can
/// call its handler after `cancel()`. `AVSpeechSynthesizer` can report an
/// utterance finished through its delegate *and* be observed to have stopped
/// speaking. In both cases the second notification is real, and forwarding it
/// would make a caller handle one utterance's ending twice.
///
/// Bounded, and ordered oldest-first: an id that fell out of the window is
/// treated as new again, which is harmless because it can no longer be the
/// active one either.
public final class SpeechTerminalLedger {
    private let lock = NSLock()
    private let capacity: Int
    private var identifiers: [String] = []

    public init(capacity: Int = 32) {
        self.capacity = max(1, capacity)
    }

    /// Records an ending. Returns false when this utterance had already ended.
    public func markEnded(_ identifier: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        if identifiers.contains(identifier) {
            return false
        }
        identifiers.append(identifier)
        while identifiers.count > capacity {
            identifiers.removeFirst()
        }
        return true
    }

    public func hasEnded(_ identifier: String) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return identifiers.contains(identifier)
    }
}

// ---------------------------------------------------------------------------
// Event bodies
// ---------------------------------------------------------------------------

/// Builds the JSON bodies the host's schemas expect.
///
/// Free functions rather than a serialisation layer: there are seven event
/// shapes in total and a table of literals is easier to check against
/// `speech-ops.ts` than a mechanism would be.
public enum SpeechEventBody {
    public static func partial(utteranceId: String, transcript: String) -> [String: Any] {
        ["type": "partial", "utteranceId": utteranceId, "transcript": transcript]
    }

    public static func final(utteranceId: String, transcript: String) -> [String: Any] {
        ["type": "final", "utteranceId": utteranceId, "transcript": transcript]
    }

    public static func inputError(
        utteranceId: String,
        code: SpeechFailureCode,
        message: String
    ) -> [String: Any] {
        [
            "type": "error",
            "utteranceId": utteranceId,
            "code": code.rawValue,
            "message": message,
        ]
    }

    public static func started(speechId: String) -> [String: Any] {
        ["type": "started", "speechId": speechId]
    }

    public static func finished(speechId: String) -> [String: Any] {
        ["type": "finished", "speechId": speechId]
    }

    public static func stopped(speechId: String) -> [String: Any] {
        ["type": "stopped", "speechId": speechId]
    }

    public static func outputError(
        speechId: String,
        code: SpeechFailureCode,
        message: String
    ) -> [String: Any] {
        [
            "type": "error",
            "speechId": speechId,
            "code": code.rawValue,
            "message": message,
        ]
    }
}

// ---------------------------------------------------------------------------
// Facts reported to the host
// ---------------------------------------------------------------------------

/// What the recogniser is, with no judgement attached.
///
/// The helper never decides whether to record: it reports these and obeys the
/// `onDevice` flag the host sends back. Same fact/verdict split as
/// `permissions.attribution` (PR-011), and for the same reason — the decision
/// is then testable on a machine with no macOS.
public struct SpeechRecognizerFacts {
    public let recognizerAvailable: Bool
    public let supportsOnDevice: Bool
    public let locale: String?
    public let supportedLocales: [String]
    public let recognizerOffline: Bool

    public init(
        recognizerAvailable: Bool,
        supportsOnDevice: Bool,
        locale: String?,
        supportedLocales: [String],
        recognizerOffline: Bool
    ) {
        self.recognizerAvailable = recognizerAvailable
        self.supportsOnDevice = supportsOnDevice
        self.locale = locale
        self.supportedLocales = supportedLocales
        self.recognizerOffline = recognizerOffline
    }

    public var jsonObject: [String: Any] {
        [
            "recognizerAvailable": recognizerAvailable,
            "supportsOnDevice": supportsOnDevice,
            "locale": JSONValue.orNull(locale),
            "supportedLocales": supportedLocales,
            "recognizerOffline": recognizerOffline,
        ]
    }
}

/// One installed voice.
public struct SpeechVoiceDescription {
    public let identifier: String
    public let name: String
    public let language: String
    public let quality: String

    public init(identifier: String, name: String, language: String, quality: String) {
        self.identifier = identifier
        self.name = name
        self.language = language
        self.quality = quality
    }

    public var jsonObject: [String: Any] {
        [
            "identifier": identifier,
            "name": name,
            "language": language,
            "quality": quality,
        ]
    }
}

/// What one `speech.*.poll` answers with.
public struct SpeechPollSnapshot {
    public let drain: SpeechDrain
    /// `recording` on the input side, `speaking` on the output side.
    public let active: Bool
    public let activeIdentifier: String?

    public init(drain: SpeechDrain, active: Bool, activeIdentifier: String?) {
        self.drain = drain
        self.active = active
        self.activeIdentifier = activeIdentifier
    }

    /// The input-side payload (`recording` / `activeUtteranceId`).
    public var inputJSONObject: [String: Any] {
        [
            "events": drain.events.map { $0.jsonObject },
            "sequence": drain.sequence,
            "dropped": drain.dropped,
            "recording": active,
            "activeUtteranceId": JSONValue.orNull(activeIdentifier),
        ]
    }

    /// The output-side payload (`speaking` / `activeSpeechId`).
    public var outputJSONObject: [String: Any] {
        [
            "events": drain.events.map { $0.jsonObject },
            "sequence": drain.sequence,
            "dropped": drain.dropped,
            "speaking": active,
            "activeSpeechId": JSONValue.orNull(activeIdentifier),
        ]
    }
}

// ---------------------------------------------------------------------------
// Speech rate
// ---------------------------------------------------------------------------

/// Maps Pilot's platform-neutral 0…1 rate onto a platform's own range.
///
/// `AVSpeechUtteranceMinimumSpeechRate` and its maximum are AVFoundation
/// constants, so they arrive as arguments and this stays pure. Out-of-range
/// input is clamped rather than rejected: a rate is a preference, and refusing
/// to speak because a slider was out of bounds would be a worse answer than
/// speaking slightly too fast.
public enum SpeechRateMapper {
    public static func platformRate(
        fraction: Double?,
        minimum: Double,
        maximum: Double,
        fallback: Double
    ) -> Double {
        guard let fraction else {
            return fallback
        }
        let clamped = min(max(fraction, 0), 1)
        let low = min(minimum, maximum)
        let high = max(minimum, maximum)
        return low + (high - low) * clamped
    }
}
