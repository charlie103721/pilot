import Foundation
import XCTest

@testable import PilotHelperCore

/// The PR-014 operations dispatched through `HelperServer` with stub services.
///
/// Covers request decoding, dispatch, response encoding and the speech error
/// mapping without a microphone, a TCC prompt or an audio device — the same
/// arrangement `HelperServerOperationsTests` uses for PR-011.
final class SpeechServerTests: XCTestCase {

    // MARK: - Stubs

    private final class StubSpeechInput: SpeechInputService {
        var report = SpeechInputAvailabilityReport(
            facts: SpeechRecognizerFacts(
                recognizerAvailable: true,
                supportsOnDevice: true,
                locale: "en-US",
                supportedLocales: ["en-US"],
                recognizerOffline: false
            ),
            microphone: .granted,
            speechRecognition: .granted
        )
        var startError: SpeechServiceError?
        var startCalls: [(utteranceId: String, onDevice: Bool, locale: String?)] = []
        var stopAccepts = true
        var cancelAccepts = true
        var localeQueries: [String?] = []
        let queue = SpeechEventQueue(capacity: 16)
        var recording = false
        var activeUtteranceId: String?

        func availability(locale: String?) -> SpeechInputAvailabilityReport {
            localeQueries.append(locale)
            return report
        }

        func start(
            utteranceId: String,
            onDevice: Bool,
            locale: String?
        ) throws -> SpeechStartOutcome {
            startCalls.append((utteranceId: utteranceId, onDevice: onDevice, locale: locale))
            if let error = startError {
                throw error
            }
            recording = true
            activeUtteranceId = utteranceId
            return SpeechStartOutcome(onDevice: onDevice, locale: locale ?? "en-US")
        }

        func stop(utteranceId: String) -> Bool {
            recording = false
            return stopAccepts
        }

        func cancel(utteranceId: String) -> Bool {
            recording = false
            activeUtteranceId = nil
            return cancelAccepts
        }

        func poll(since: Int) -> SpeechPollSnapshot {
            SpeechPollSnapshot(
                drain: queue.drain(since: since),
                active: recording,
                activeIdentifier: activeUtteranceId
            )
        }
    }

    private final class StubSpeechOutput: SpeechOutputService {
        var voices: [SpeechVoiceDescription] = [
            SpeechVoiceDescription(
                identifier: "com.apple.voice.compact.en-US.Samantha",
                name: "Samantha",
                language: "en-US",
                quality: "default"
            )
        ]
        var speakError: SpeechServiceError?
        var spoken: [(speechId: String, text: String, voice: String?, rate: Double?)] = []
        var stopReturns: [String] = []
        var stopCalls: [String?] = []
        let queue = SpeechEventQueue(capacity: 16)
        var speaking = false
        var activeSpeechId: String?

        func availability() -> (available: Bool, voices: [SpeechVoiceDescription]) {
            (available: !voices.isEmpty, voices: voices)
        }

        func speak(speechId: String, text: String, voice: String?, rate: Double?) throws -> Bool {
            if let error = speakError {
                throw error
            }
            let queued = speaking
            spoken.append((speechId: speechId, text: text, voice: voice, rate: rate))
            speaking = true
            activeSpeechId = speechId
            return queued
        }

        func stop(speechId: String?) -> [String] {
            stopCalls.append(speechId)
            speaking = false
            activeSpeechId = nil
            return stopReturns
        }

        func poll(since: Int) -> SpeechPollSnapshot {
            SpeechPollSnapshot(
                drain: queue.drain(since: since),
                active: speaking,
                activeIdentifier: activeSpeechId
            )
        }
    }

    // MARK: - Helpers

    private func makeServer(
        input: StubSpeechInput = StubSpeechInput(),
        output: StubSpeechOutput = StubSpeechOutput()
    ) -> HelperServer {
        HelperServer(
            helperVersion: "0.1.0",
            processIdentifier: 4321,
            speechInput: input,
            speechOutput: output
        )
    }

    private func answer(
        _ server: HelperServer,
        id: String,
        op: String,
        payload: [String: Any] = [:]
    ) throws -> [String: Any] {
        let message = HelperProtocol.requestMessage(id: id, op: op, payload: payload)
        let text = try HelperProtocol.encode(message)
        let outcome = server.handle(frame: Frame(messageText: text))
        guard case .reply(let frame) = outcome else {
            XCTFail("expected a reply for \"\(op)\"")
            return [:]
        }
        let object = try JSONSerialization.jsonObject(with: Data(frame.message), options: [])
        guard let dictionary = object as? [String: Any] else {
            XCTFail("expected a JSON object")
            return [:]
        }
        return dictionary
    }

    private func payload(_ response: [String: Any]) throws -> [String: Any] {
        try XCTUnwrap(response["payload"] as? [String: Any])
    }

    private func error(_ response: [String: Any]) throws -> [String: Any] {
        try XCTUnwrap(response["error"] as? [String: Any])
    }

    // MARK: - Availability

    func testAvailabilityReportsFactsAndBothPermissionsSeparately() throws {
        let input = StubSpeechInput()
        input.report = SpeechInputAvailabilityReport(
            facts: SpeechRecognizerFacts(
                recognizerAvailable: true,
                supportsOnDevice: false,
                locale: "fr-FR",
                supportedLocales: ["en-US", "fr-FR"],
                recognizerOffline: false
            ),
            microphone: .granted,
            speechRecognition: .denied
        )
        let server = makeServer(input: input)

        let response = try answer(
            server, id: "r1", op: "speech.input.availability", payload: ["locale": "fr-FR"])
        XCTAssertEqual(response["ok"] as? Bool, true)

        let body = try payload(response)
        XCTAssertEqual(body["microphone"] as? String, "granted")
        XCTAssertEqual(body["speechRecognition"] as? String, "denied")
        let facts = try XCTUnwrap(body["facts"] as? [String: Any])
        XCTAssertEqual(facts["supportsOnDevice"] as? Bool, false)
        XCTAssertEqual(facts["locale"] as? String, "fr-FR")
        XCTAssertEqual(input.localeQueries, ["fr-FR"])
    }

    // MARK: - Start

    func testStartPassesTheHostsOnDeviceDecisionThrough() throws {
        let input = StubSpeechInput()
        let server = makeServer(input: input)

        let response = try answer(
            server,
            id: "r2",
            op: "speech.input.start",
            payload: ["utteranceId": "utt-1", "onDevice": true, "locale": "en-US"]
        )
        XCTAssertEqual(response["ok"] as? Bool, true)
        XCTAssertEqual(try payload(response)["onDevice"] as? Bool, true)
        XCTAssertEqual(input.startCalls.count, 1)
        XCTAssertEqual(input.startCalls[0].utteranceId, "utt-1")
        XCTAssertTrue(input.startCalls[0].onDevice)
    }

    func testStartRejectsAMissingOnDeviceDecision() throws {
        let server = makeServer()
        let response = try answer(
            server, id: "r3", op: "speech.input.start", payload: ["utteranceId": "utt-1"])
        XCTAssertEqual(response["ok"] as? Bool, false)
        XCTAssertEqual(try error(response)["code"] as? String, "invalid-request")
    }

    /// A refusal to record on privacy grounds must arrive as
    /// `speech-unavailable`, not as a generic transport error: it is a product
    /// behaviour the UI has something specific to say about.
    func testOnDeviceRefusalIsReportedAsSpeechUnavailable() throws {
        let input = StubSpeechInput()
        input.startError = SpeechServiceError(
            code: .onDeviceUnavailable,
            message: "On-device recognition is unavailable for this locale"
        )
        let server = makeServer(input: input)

        let response = try answer(
            server,
            id: "r4",
            op: "speech.input.start",
            payload: ["utteranceId": "utt-1", "onDevice": true]
        )
        XCTAssertEqual(response["ok"] as? Bool, false)
        let body = try error(response)
        XCTAssertEqual(body["code"] as? String, "speech-unavailable")
        XCTAssertEqual(body["domain"] as? String, "speech")
        XCTAssertEqual(
            body["message"] as? String,
            "on-device-unavailable: On-device recognition is unavailable for this locale"
        )
    }

    func testPermissionFailuresKeepThePermissionDomain() throws {
        let input = StubSpeechInput()
        input.startError = SpeechServiceError(
            code: .permissionDenied,
            message: "Microphone permission is denied"
        )
        let server = makeServer(input: input)

        let response = try answer(
            server,
            id: "r5",
            op: "speech.input.start",
            payload: ["utteranceId": "utt-1", "onDevice": true]
        )
        let body = try error(response)
        XCTAssertEqual(body["code"] as? String, "permission-denied")
        XCTAssertEqual(body["domain"] as? String, "permission")
    }

    // MARK: - Stop and cancel

    /// The behaviour the whole teardown story rests on: stopping an utterance
    /// the recogniser already finished answers `accepted: false` and is a
    /// success, not an error.
    func testStopAnswersAcceptedFalseRatherThanFailing() throws {
        let input = StubSpeechInput()
        input.stopAccepts = false
        let server = makeServer(input: input)

        let response = try answer(
            server, id: "r6", op: "speech.input.stop", payload: ["utteranceId": "utt-1"])
        XCTAssertEqual(response["ok"] as? Bool, true)
        XCTAssertEqual(try payload(response)["accepted"] as? Bool, false)
    }

    func testCancelAnswersAcceptedFalseForAnUnknownUtterance() throws {
        let input = StubSpeechInput()
        input.cancelAccepts = false
        let server = makeServer(input: input)

        let response = try answer(
            server, id: "r7", op: "speech.input.cancel", payload: ["utteranceId": "utt-9"])
        XCTAssertEqual(response["ok"] as? Bool, true)
        XCTAssertEqual(try payload(response)["accepted"] as? Bool, false)
    }

    func testStopRequiresAnUtteranceId() throws {
        let server = makeServer()
        let response = try answer(server, id: "r8", op: "speech.input.stop")
        XCTAssertEqual(response["ok"] as? Bool, false)
    }

    // MARK: - Poll

    func testInputPollDrainsQueuedEvents() throws {
        let input = StubSpeechInput()
        input.recording = true
        input.activeUtteranceId = "utt-1"
        input.queue.append(SpeechEventBody.partial(utteranceId: "utt-1", transcript: "what"))
        input.queue.append(SpeechEventBody.final(utteranceId: "utt-1", transcript: "what is this?"))
        let server = makeServer(input: input)

        let response = try answer(
            server, id: "r9", op: "speech.input.poll", payload: ["sinceSequence": 0])
        let body = try payload(response)
        let events = try XCTUnwrap(body["events"] as? [[String: Any]])
        XCTAssertEqual(events.count, 2)
        XCTAssertEqual(events[1]["type"] as? String, "final")
        XCTAssertEqual(body["recording"] as? Bool, true)
        XCTAssertEqual(body["activeUtteranceId"] as? String, "utt-1")
        XCTAssertEqual(body["dropped"] as? Int, 0)
    }

    func testInputPollRequiresASequence() throws {
        let server = makeServer()
        let response = try answer(server, id: "r10", op: "speech.input.poll")
        XCTAssertEqual(response["ok"] as? Bool, false)
    }

    // MARK: - Output

    func testOutputAvailabilityListsVoices() throws {
        let server = makeServer()
        let response = try answer(server, id: "r11", op: "speech.output.availability")
        let body = try payload(response)
        XCTAssertEqual(body["available"] as? Bool, true)
        let voices = try XCTUnwrap(body["voices"] as? [[String: Any]])
        XCTAssertEqual(voices[0]["identifier"] as? String, "com.apple.voice.compact.en-US.Samantha")
        XCTAssertEqual(voices[0]["quality"] as? String, "default")
    }

    func testSpeakForwardsVoiceAndRateAndReportsQueueing() throws {
        let output = StubSpeechOutput()
        let server = makeServer(output: output)

        let first = try answer(
            server,
            id: "r12",
            op: "speech.output.speak",
            payload: ["speechId": "speech-1", "text": "Hello.", "voice": "en-GB", "rate": 0.4]
        )
        XCTAssertEqual(try payload(first)["queued"] as? Bool, false)

        let second = try answer(
            server,
            id: "r13",
            op: "speech.output.speak",
            payload: ["speechId": "speech-2", "text": "And then this."]
        )
        XCTAssertEqual(try payload(second)["queued"] as? Bool, true)

        XCTAssertEqual(output.spoken.count, 2)
        XCTAssertEqual(output.spoken[0].voice, "en-GB")
        XCTAssertEqual(output.spoken[0].rate ?? 0, 0.4, accuracy: 0.000_001)
        XCTAssertNil(output.spoken[1].voice)
        XCTAssertNil(output.spoken[1].rate)
    }

    func testSpeakRejectsEmptyText() throws {
        let server = makeServer()
        let response = try answer(
            server,
            id: "r14",
            op: "speech.output.speak",
            payload: ["speechId": "speech-1", "text": ""]
        )
        XCTAssertEqual(response["ok"] as? Bool, false)
        XCTAssertEqual(try error(response)["code"] as? String, "invalid-request")
    }

    func testAMacWithNoVoiceReportsSpeechUnavailable() throws {
        let output = StubSpeechOutput()
        output.speakError = SpeechServiceError(
            code: .voiceUnavailable,
            message: "No speech synthesis voice is installed"
        )
        let server = makeServer(output: output)

        let response = try answer(
            server,
            id: "r15",
            op: "speech.output.speak",
            payload: ["speechId": "speech-1", "text": "Hello."]
        )
        XCTAssertEqual(try error(response)["code"] as? String, "speech-unavailable")
    }

    /// Stopping returns every discarded utterance, because the synthesiser has
    /// one queue and one stop — the host emits an event for each of them.
    func testStopReturnsEveryDiscardedUtterance() throws {
        let output = StubSpeechOutput()
        output.stopReturns = ["speech-1", "speech-2"]
        let server = makeServer(output: output)

        let response = try answer(
            server, id: "r16", op: "speech.output.stop", payload: ["speechId": "speech-1"])
        XCTAssertEqual(try payload(response)["stopped"] as? [String], ["speech-1", "speech-2"])
        XCTAssertEqual(output.stopCalls, ["speech-1"])
    }

    func testStopWithoutAnIdStopsEverything() throws {
        let output = StubSpeechOutput()
        let server = makeServer(output: output)
        _ = try answer(server, id: "r17", op: "speech.output.stop")
        XCTAssertEqual(output.stopCalls.count, 1)
        XCTAssertNil(output.stopCalls[0])
    }

    func testOutputPollReportsSpeakingAndActiveId() throws {
        let output = StubSpeechOutput()
        output.speaking = true
        output.activeSpeechId = "speech-1"
        output.queue.append(SpeechEventBody.started(speechId: "speech-1"))
        let server = makeServer(output: output)

        let response = try answer(
            server, id: "r18", op: "speech.output.poll", payload: ["sinceSequence": 0])
        let body = try payload(response)
        XCTAssertEqual(body["speaking"] as? Bool, true)
        XCTAssertEqual(body["activeSpeechId"] as? String, "speech-1")
        let events = try XCTUnwrap(body["events"] as? [[String: Any]])
        XCTAssertEqual(events[0]["type"] as? String, "started")
    }

    // MARK: - Protocol hygiene

    /// No speech operation may ever carry a binary body: that is the mechanical
    /// half of "raw audio never leaves this process" (system-design §13).
    func testSpeechResponsesCarryNoBinaryBody() throws {
        let server = makeServer()
        let operations = [
            "speech.input.availability",
            "speech.input.poll",
            "speech.output.availability",
            "speech.output.poll",
        ]
        for (index, op) in operations.enumerated() {
            let message = HelperProtocol.requestMessage(
                id: "b\(index)",
                op: op,
                payload: ["sinceSequence": 0]
            )
            let text = try HelperProtocol.encode(message)
            let outcome = server.handle(frame: Frame(messageText: text))
            guard case .reply(let frame) = outcome else {
                XCTFail("expected a reply for \"\(op)\"")
                continue
            }
            XCTAssertEqual(frame.binary.count, 0, "\(op) attached binary")
        }
    }

    func testEverySpeechOperationNameIsRoutable() {
        let names = [
            "speech.input.availability",
            "speech.input.start",
            "speech.input.stop",
            "speech.input.cancel",
            "speech.input.poll",
            "speech.output.availability",
            "speech.output.speak",
            "speech.output.stop",
            "speech.output.poll",
        ]
        for name in names {
            XCTAssertNotNil(
                HelperProtocol.Operation(rawValue: name), "\(name) is not a known operation")
        }
    }
}
