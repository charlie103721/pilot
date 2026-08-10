import Foundation
import XCTest

@testable import PilotHelperCore

/// The pure half of PR-014: the event queue, the terminal ledger, the error
/// classifier and the rate mapper.
///
/// Everything Apple Speech and `AVSpeechSynthesizer` actually do is
/// unverifiable on the development machine (runbook amendment 8). What is
/// verifiable is the logic that decides what the host is *told* when they do
/// something — including the two behaviours the whole design leans on: a
/// recogniser that finalises twice, and a recogniser that fires after cancel.
final class SpeechModelTests: XCTestCase {

    // MARK: - Event queue

    func testDrainReturnsEventsInOrderWithSequenceNumbers() {
        let queue = SpeechEventQueue(capacity: 8)
        queue.append(SpeechEventBody.partial(utteranceId: "utt-1", transcript: "what"))
        queue.append(SpeechEventBody.final(utteranceId: "utt-1", transcript: "what is this?"))

        let drain = queue.drain(since: 0)
        XCTAssertEqual(drain.events.count, 2)
        XCTAssertEqual(drain.events[0].sequence, 1)
        XCTAssertEqual(drain.events[1].sequence, 2)
        XCTAssertEqual(drain.sequence, 2)
        XCTAssertEqual(drain.dropped, 0)
        XCTAssertEqual(drain.events[0].jsonObject["type"] as? String, "partial")
        XCTAssertEqual(drain.events[1].jsonObject["transcript"] as? String, "what is this?")
        XCTAssertEqual(drain.events[1].jsonObject["sequence"] as? Int, 2)
    }

    /// A poll whose response was lost must be repeatable, so draining below
    /// the high-water mark returns the same events again.
    func testDrainIsIdempotentUntilTheHostAcknowledges() {
        let queue = SpeechEventQueue(capacity: 8)
        queue.append(SpeechEventBody.partial(utteranceId: "utt-1", transcript: "a"))
        queue.append(SpeechEventBody.partial(utteranceId: "utt-1", transcript: "ab"))

        XCTAssertEqual(queue.drain(since: 0).events.count, 2)
        XCTAssertEqual(queue.drain(since: 0).events.count, 2)
        XCTAssertEqual(queue.drain(since: 1).events.count, 1)
        XCTAssertEqual(queue.drain(since: 2).events.count, 0)
    }

    /// Overflow drops the *oldest* event: in an overflowing queue the oldest
    /// entry is a stale partial hypothesis and the newest is the transcript.
    func testOverflowDropsTheOldestEventsAndCountsThem() {
        let queue = SpeechEventQueue(capacity: 2)
        queue.append(SpeechEventBody.partial(utteranceId: "utt-1", transcript: "one"))
        queue.append(SpeechEventBody.partial(utteranceId: "utt-1", transcript: "two"))
        queue.append(SpeechEventBody.final(utteranceId: "utt-1", transcript: "three"))

        let drain = queue.drain(since: 0)
        XCTAssertEqual(drain.events.count, 2)
        XCTAssertEqual(drain.events[0].jsonObject["transcript"] as? String, "two")
        XCTAssertEqual(drain.events[1].jsonObject["type"] as? String, "final")
        XCTAssertEqual(drain.dropped, 1)
    }

    func testClearDiscardsQueuedEventsButKeepsTheSequence() {
        let queue = SpeechEventQueue(capacity: 8)
        queue.append(SpeechEventBody.partial(utteranceId: "utt-1", transcript: "a"))
        queue.clear()

        let drain = queue.drain(since: 0)
        XCTAssertEqual(drain.events.count, 0)
        XCTAssertEqual(drain.sequence, 1)
    }

    // MARK: - Terminal ledger

    func testLedgerAcceptsOneEndingPerUtterance() {
        let ledger = SpeechTerminalLedger(capacity: 4)
        XCTAssertTrue(ledger.markEnded("utt-1"))
        XCTAssertFalse(ledger.markEnded("utt-1"))
        XCTAssertTrue(ledger.hasEnded("utt-1"))
        XCTAssertFalse(ledger.hasEnded("utt-2"))
    }

    func testLedgerForgetsTheOldestEntries() {
        let ledger = SpeechTerminalLedger(capacity: 2)
        XCTAssertTrue(ledger.markEnded("utt-1"))
        XCTAssertTrue(ledger.markEnded("utt-2"))
        XCTAssertTrue(ledger.markEnded("utt-3"))
        XCTAssertFalse(ledger.hasEnded("utt-1"))
        XCTAssertTrue(ledger.hasEnded("utt-3"))
    }

    // MARK: - Error classification

    func testNoSpeechCodesAreNotTreatedAsRecognitionFailures() {
        XCTAssertEqual(
            SpeechErrorMapper.classify(
                domain: SpeechErrorMapper.assistantErrorDomain, code: 1110),
            .noSpeech
        )
        XCTAssertEqual(
            SpeechErrorMapper.classify(domain: SpeechErrorMapper.assistantErrorDomain, code: 203),
            .noSpeech
        )
    }

    func testLocalRecognitionUnavailableIsItsOwnCode() {
        XCTAssertEqual(
            SpeechErrorMapper.classify(
                domain: SpeechErrorMapper.assistantErrorDomain, code: 1101),
            .onDeviceUnavailable
        )
    }

    func testCancellationIsNeverReportedAsAFailure() {
        XCTAssertEqual(
            SpeechErrorMapper.classify(domain: NSCocoaErrorDomain, code: NSUserCancelledError),
            .cancelled
        )
        XCTAssertEqual(
            SpeechErrorMapper.classify(domain: SpeechErrorMapper.assistantErrorDomain, code: 216),
            .cancelled
        )
    }

    func testNetworkFailuresReportTheRecogniserUnavailable() {
        XCTAssertEqual(
            SpeechErrorMapper.classify(domain: NSURLErrorDomain, code: -1009),
            .recognizerUnavailable
        )
    }

    /// An unknown number is still a recognition failure — never a crash, and
    /// never `internal`, which is reserved for the helper's own bugs.
    func testUnknownErrorsDegradeToRecognizerFailed() {
        XCTAssertEqual(
            SpeechErrorMapper.classify(domain: "com.example.unknown", code: 42),
            .recognizerFailed
        )
        XCTAssertEqual(
            SpeechErrorMapper.classify(
                domain: SpeechErrorMapper.assistantErrorDomain, code: 999_999),
            .recognizerFailed
        )
    }

    func testNSErrorOverloadUsesDomainAndCode() {
        let error = NSError(
            domain: SpeechErrorMapper.assistantErrorDomain, code: 1110, userInfo: nil)
        XCTAssertEqual(SpeechErrorMapper.classify(error), .noSpeech)
    }

    // MARK: - Poll snapshots

    func testInputAndOutputSnapshotsUseTheirOwnFieldNames() {
        let queue = SpeechEventQueue(capacity: 4)
        queue.append(SpeechEventBody.started(speechId: "speech-1"))
        let snapshot = SpeechPollSnapshot(
            drain: queue.drain(since: 0),
            active: true,
            activeIdentifier: "speech-1"
        )

        let input = snapshot.inputJSONObject
        XCTAssertEqual(input["recording"] as? Bool, true)
        XCTAssertEqual(input["activeUtteranceId"] as? String, "speech-1")
        XCTAssertNil(input["speaking"])

        let output = snapshot.outputJSONObject
        XCTAssertEqual(output["speaking"] as? Bool, true)
        XCTAssertEqual(output["activeSpeechId"] as? String, "speech-1")
        XCTAssertNil(output["recording"])
    }

    func testAnIdleSnapshotReportsNullRatherThanAnEmptyString() throws {
        let snapshot = SpeechPollSnapshot(
            drain: SpeechEventQueue(capacity: 2).drain(since: 0),
            active: false,
            activeIdentifier: nil
        )
        let encoded = try HelperProtocol.encode(snapshot.inputJSONObject)
        XCTAssertTrue(encoded.contains("\"activeUtteranceId\":null"))
    }

    // MARK: - Recogniser facts

    func testFactsSerialiseWithoutInventingALocale() throws {
        let facts = SpeechRecognizerFacts(
            recognizerAvailable: false,
            supportsOnDevice: false,
            locale: nil,
            supportedLocales: ["en-US", "fr-FR"],
            recognizerOffline: true
        )
        let encoded = try HelperProtocol.encode(facts.jsonObject)
        XCTAssertTrue(encoded.contains("\"locale\":null"))
        XCTAssertTrue(encoded.contains("\"recognizerOffline\":true"))
    }

    // MARK: - Rate mapping

    func testRateMapsTheUnitRangeOntoThePlatformRange() {
        XCTAssertEqual(
            SpeechRateMapper.platformRate(fraction: 0, minimum: 0.1, maximum: 0.9, fallback: 0.5),
            0.1,
            accuracy: 0.000_001
        )
        XCTAssertEqual(
            SpeechRateMapper.platformRate(fraction: 1, minimum: 0.1, maximum: 0.9, fallback: 0.5),
            0.9,
            accuracy: 0.000_001
        )
        XCTAssertEqual(
            SpeechRateMapper.platformRate(fraction: 0.5, minimum: 0.1, maximum: 0.9, fallback: 0.5),
            0.5,
            accuracy: 0.000_001
        )
    }

    /// A rate is a preference. Refusing to speak because a slider was out of
    /// bounds would be a worse answer than speaking slightly too fast.
    func testOutOfRangeRatesAreClampedAndMissingOnesUseTheFallback() {
        XCTAssertEqual(
            SpeechRateMapper.platformRate(fraction: 4, minimum: 0.1, maximum: 0.9, fallback: 0.5),
            0.9,
            accuracy: 0.000_001
        )
        XCTAssertEqual(
            SpeechRateMapper.platformRate(fraction: -2, minimum: 0.1, maximum: 0.9, fallback: 0.5),
            0.1,
            accuracy: 0.000_001
        )
        XCTAssertEqual(
            SpeechRateMapper.platformRate(
                fraction: nil, minimum: 0.1, maximum: 0.9, fallback: 0.42),
            0.42,
            accuracy: 0.000_001
        )
    }

    func testInvertedPlatformRangeStillProducesValuesInsideIt() {
        let value = SpeechRateMapper.platformRate(
            fraction: 0.25, minimum: 0.9, maximum: 0.1, fallback: 0.5)
        XCTAssertGreaterThanOrEqual(value, 0.1)
        XCTAssertLessThanOrEqual(value, 0.9)
    }
}
