import Foundation
import XCTest

@testable import PilotHelperCore

/// The pure half of PR-012: the request parser and its clamps, the bounded
/// hand-off queue and its drop accounting, and the presentation-timestamp
/// conversion.
///
/// None of this needs a compositor, a window server or a permission, which is
/// why it lives apart from `CaptureEngine.swift`.
final class CaptureModelTests: XCTestCase {

    // MARK: - Configuration

    private func startPayload(_ overrides: [String: Any] = [:]) -> [String: Any] {
        var payload: [String: Any] = [
            "windowNumber": 42,
            "width": 1440,
            "height": 960,
            "sampleFps": 3.0,
            "includeCursor": false,
            "encoding": "jpeg",
            "quality": 0.9,
        ]
        for (key, value) in overrides {
            payload[key] = value
        }
        return payload
    }

    func testParsesAWellFormedRequest() throws {
        let settings = try XCTUnwrap(CaptureConfiguration.parse(startPayload()))

        XCTAssertEqual(settings.windowNumber, 42)
        XCTAssertEqual(settings.width, 1440)
        XCTAssertEqual(settings.height, 960)
        XCTAssertEqual(settings.sampleFps, 3.0, accuracy: 0.000_1)
        XCTAssertEqual(settings.encoding, .jpeg)
        XCTAssertFalse(settings.includeCursor)
    }

    func testRejectsARequestWithoutTheFieldsItNeeds() {
        XCTAssertNil(CaptureConfiguration.parse([:]))
        XCTAssertNil(CaptureConfiguration.parse(startPayload(["width": 0])))
        XCTAssertNil(CaptureConfiguration.parse(startPayload(["height": -1])))
        XCTAssertNil(CaptureConfiguration.parse(startPayload(["windowNumber": "42"])))
    }

    func testClampsValuesToTheProtocolBounds() throws {
        let big = try XCTUnwrap(
            CaptureConfiguration.parse(
                startPayload(["width": 99_999, "height": 99_999, "sampleFps": 500.0])
            )
        )
        XCTAssertEqual(big.width, CaptureLimits.maxEdgePixels)
        XCTAssertEqual(big.height, CaptureLimits.maxEdgePixels)
        XCTAssertEqual(big.sampleFps, CaptureLimits.maxFps, accuracy: 0.000_1)

        let small = try XCTUnwrap(
            CaptureConfiguration.parse(startPayload(["sampleFps": 0.000_1, "quality": 5.0]))
        )
        XCTAssertEqual(small.sampleFps, CaptureLimits.minFps, accuracy: 0.000_1)
        XCTAssertEqual(small.quality, 1.0, accuracy: 0.000_1)
    }

    func testDerivesTheResendCadenceFromTheSampleRate() throws {
        let settings = try XCTUnwrap(CaptureConfiguration.parse(startPayload()))

        XCTAssertEqual(settings.frameIntervalMilliseconds, 333)
        XCTAssertEqual(settings.resendUnchangedAfterMs, 333)
    }

    func testUnknownEncodingFallsBackToJpegRatherThanFailing() throws {
        let settings = try XCTUnwrap(CaptureConfiguration.parse(startPayload(["encoding": "webp"])))

        XCTAssertEqual(settings.encoding, .jpeg)
    }

    // MARK: - Queue

    private func record(
        sequence: Int,
        capturedAt: Int,
        bytes: Int = 16,
        contentChanged: Bool = true
    ) -> CaptureFrameRecord {
        return CaptureFrameRecord(
            sequence: sequence,
            windowNumber: 42,
            capturedAt: capturedAt,
            timestampFallback: false,
            width: 1440,
            height: 960,
            scaleFactor: 1.2,
            encoding: .jpeg,
            bytes: [UInt8](repeating: 7, count: bytes),
            contentChanged: contentChanged
        )
    }

    func testQueueIsFirstInFirstOut() {
        let queue = CaptureQueue(depthLimit: 4, byteLimit: 1024)
        queue.enqueue(record(sequence: 1, capturedAt: 1_000))
        queue.enqueue(record(sequence: 2, capturedAt: 1_100))

        XCTAssertEqual(queue.dequeue(notBefore: nil, now: 1_200, maxAgeMilliseconds: 3_000)?.sequence, 1)
        XCTAssertEqual(queue.dequeue(notBefore: nil, now: 1_200, maxAgeMilliseconds: 3_000)?.sequence, 2)
        XCTAssertNil(queue.dequeue(notBefore: nil, now: 1_200, maxAgeMilliseconds: 3_000))
        XCTAssertEqual(queue.delivered, 2)
    }

    func testQueueRefusesAFrameWithNoBytes() {
        let queue = CaptureQueue(depthLimit: 4, byteLimit: 1024)

        XCTAssertFalse(queue.enqueue(record(sequence: 1, capturedAt: 1_000, bytes: 0)))
        XCTAssertEqual(queue.count, 0)
    }

    func testQueueDropsTheOldestWhenItOverflowsOnDepth() {
        let queue = CaptureQueue(depthLimit: 2, byteLimit: 10_000)
        queue.enqueue(record(sequence: 1, capturedAt: 1_000))
        queue.enqueue(record(sequence: 2, capturedAt: 1_100))
        queue.enqueue(record(sequence: 3, capturedAt: 1_200))

        XCTAssertEqual(queue.count, 2)
        XCTAssertEqual(queue.dropped, 1)
        // The newest picture of the screen is the one worth keeping.
        XCTAssertEqual(queue.dequeue(notBefore: nil, now: 1_300, maxAgeMilliseconds: 3_000)?.sequence, 2)
    }

    func testQueueDropsTheOldestWhenItOverflowsOnBytes() {
        let queue = CaptureQueue(depthLimit: 16, byteLimit: 40)
        queue.enqueue(record(sequence: 1, capturedAt: 1_000, bytes: 32))
        queue.enqueue(record(sequence: 2, capturedAt: 1_100, bytes: 32))

        XCTAssertEqual(queue.count, 1)
        XCTAssertEqual(queue.dropped, 1)
        XCTAssertEqual(queue.byteCount, 32)
    }

    func testQueueKeepsASingleOversizedFrameRatherThanEmptyingItself() {
        let queue = CaptureQueue(depthLimit: 4, byteLimit: 10)
        queue.enqueue(record(sequence: 1, capturedAt: 1_000, bytes: 64))

        // Dropping it would leave nothing at all; the host's own bound rejects
        // a frame it cannot hold, and says which reason it used.
        XCTAssertEqual(queue.count, 1)
    }

    func testDequeueDiscardsFramesOlderThanTheWatermark() {
        let queue = CaptureQueue(depthLimit: 8, byteLimit: 10_000)
        queue.enqueue(record(sequence: 1, capturedAt: 1_000))
        queue.enqueue(record(sequence: 2, capturedAt: 1_500))
        queue.enqueue(record(sequence: 3, capturedAt: 2_000))

        let frame = queue.dequeue(notBefore: 1_600, now: 2_100, maxAgeMilliseconds: 3_000)

        XCTAssertEqual(frame?.sequence, 3)
        XCTAssertEqual(queue.dropped, 2)
    }

    func testDequeueDiscardsFramesPastTheAgeBound() {
        let queue = CaptureQueue(depthLimit: 8, byteLimit: 10_000)
        queue.enqueue(record(sequence: 1, capturedAt: 1_000))
        queue.enqueue(record(sequence: 2, capturedAt: 9_000))

        let frame = queue.dequeue(notBefore: nil, now: 9_100, maxAgeMilliseconds: 3_000)

        XCTAssertEqual(frame?.sequence, 2)
        XCTAssertEqual(queue.dropped, 1)
    }

    func testClearReportsWhatItDiscarded() {
        let queue = CaptureQueue(depthLimit: 8, byteLimit: 10_000)
        queue.enqueue(record(sequence: 1, capturedAt: 1_000))
        queue.enqueue(record(sequence: 2, capturedAt: 1_100))

        XCTAssertEqual(queue.clear(), 2)
        XCTAssertEqual(queue.count, 0)
        XCTAssertEqual(queue.byteCount, 0)
    }

    // MARK: - Timestamps

    func testConvertsAPresentationTimestampOntoTheEpochBase() {
        let converted = CaptureTimestamp.wallClockMilliseconds(
            presentationSeconds: 4_512.0,
            hostNowSeconds: 4_512.25,
            wallNowMilliseconds: 1_700_000_000_000
        )

        // The frame is 250 ms old, so it happened 250 ms before "now".
        XCTAssertEqual(converted.milliseconds, 1_699_999_999_750)
        XCTAssertFalse(converted.fallback)
    }

    func testFallsBackWhenTheFrameAppearsToComeFromTheFuture() {
        let converted = CaptureTimestamp.wallClockMilliseconds(
            presentationSeconds: 4_513.0,
            hostNowSeconds: 4_512.0,
            wallNowMilliseconds: 1_700_000_000_000
        )

        XCTAssertTrue(converted.fallback)
        XCTAssertEqual(converted.milliseconds, 1_700_000_000_000)
    }

    func testFallsBackWhenTheAgeIsImplausiblyLarge() {
        let converted = CaptureTimestamp.wallClockMilliseconds(
            presentationSeconds: 0,
            hostNowSeconds: 4_512.0,
            wallNowMilliseconds: 1_700_000_000_000
        )

        XCTAssertTrue(converted.fallback)
        XCTAssertEqual(converted.milliseconds, 1_700_000_000_000)
    }

    func testFallsBackOnANonFiniteTimestamp() {
        let converted = CaptureTimestamp.wallClockMilliseconds(
            presentationSeconds: Double.nan,
            hostNowSeconds: 4_512.0,
            wallNowMilliseconds: 1_700_000_000_000
        )

        XCTAssertTrue(converted.fallback)
    }

    // MARK: - Serialisation

    func testFrameJsonCarriesTheByteLengthButNotTheBytes() {
        let json = record(sequence: 9, capturedAt: 1_234, bytes: 512).jsonObject(streamId: "cap-1")

        XCTAssertEqual(json["streamId"] as? String, "cap-1")
        XCTAssertEqual(json["sequence"] as? Int, 9)
        XCTAssertEqual(json["byteLength"] as? Int, 512)
        XCTAssertEqual(json["capturedAt"] as? Int, 1_234)
        XCTAssertEqual(json["contentChanged"] as? Bool, true)
        XCTAssertNil(json["bytes"])
    }

    func testPullOutcomeSerialisesAnAbsentFrameAsNull() throws {
        let outcome = CapturePullOutcome(
            state: .protectedContent,
            streamId: "cap-1",
            frame: nil,
            remaining: 0,
            dropped: 2,
            delivered: 5,
            failure: nil
        )

        let json = outcome.jsonObject
        XCTAssertEqual(json["state"] as? String, "protected")
        XCTAssertTrue(json["frame"] is NSNull)
        XCTAssertTrue(json["failure"] is NSNull)
        XCTAssertEqual(json["dropped"] as? Int, 2)
        // It has to survive JSONSerialization, which NSNull does and nil does not.
        XCTAssertNoThrow(try HelperProtocol.encode(json))
    }
}
