import XCTest

@testable import PilotHelperCore

final class FrameCodecTests: XCTestCase {
    private func header(
        magic: [UInt8] = FrameConstants.magic,
        version: UInt8 = FrameConstants.protocolVersion,
        flags: UInt8 = 0,
        reserved: UInt16 = 0,
        messageLength: UInt32 = 2,
        binaryLength: UInt32 = 0
    ) -> [UInt8] {
        var bytes = [UInt8]()
        bytes.append(contentsOf: magic)
        bytes.append(version)
        bytes.append(flags)
        bytes.append(UInt8((reserved >> 8) & 0xFF))
        bytes.append(UInt8(reserved & 0xFF))
        bytes.append(contentsOf: FrameCodec.bigEndianBytes(messageLength))
        bytes.append(contentsOf: FrameCodec.bigEndianBytes(binaryLength))
        return bytes
    }

    func testHeaderLayoutMatchesTheDocumentedWireFormat() throws {
        let frame = Frame(messageText: "{\"a\":1}", binary: [1, 2, 3])
        let bytes = try FrameCodec.encode(frame)

        XCTAssertEqual(Array(bytes[0..<4]), FrameConstants.magic)
        XCTAssertEqual(bytes[4], FrameConstants.protocolVersion)
        XCTAssertEqual(bytes[5], 0)
        XCTAssertEqual(FrameCodec.readUInt16(bytes, at: 6), 0)
        XCTAssertEqual(FrameCodec.readUInt32(bytes, at: 8), 7)
        XCTAssertEqual(FrameCodec.readUInt32(bytes, at: 12), 3)
        XCTAssertEqual(bytes.count, FrameConstants.headerByteLength + 7 + 3)
    }

    func testRejectsBadMagic() {
        let bytes = header(magic: [0, 0, 0, 0])
        XCTAssertThrowsError(try FrameCodec.decodeHeader(bytes, at: 0)) { error in
            XCTAssertEqual(error as? FrameError, FrameError.badMagic)
        }
    }

    func testRejectsUnsupportedVersion() {
        let bytes = header(version: 2)
        XCTAssertThrowsError(try FrameCodec.decodeHeader(bytes, at: 0)) { error in
            XCTAssertEqual(error as? FrameError, FrameError.unsupportedVersion(2))
        }
    }

    func testRejectsReservedBits() {
        let flagged = header(flags: 1)
        XCTAssertThrowsError(try FrameCodec.decodeHeader(flagged, at: 0)) { error in
            XCTAssertEqual(error as? FrameError, FrameError.reservedBitsSet)
        }

        let reserved = header(reserved: 5)
        XCTAssertThrowsError(try FrameCodec.decodeHeader(reserved, at: 0)) { error in
            XCTAssertEqual(error as? FrameError, FrameError.reservedBitsSet)
        }
    }

    func testRejectsEmptyMessage() {
        let bytes = header(messageLength: 0)
        XCTAssertThrowsError(try FrameCodec.decodeHeader(bytes, at: 0)) { error in
            XCTAssertEqual(error as? FrameError, FrameError.emptyMessage)
        }
    }

    func testRejectsOversizedBodiesFromTheHeaderAlone() {
        let tooBigMessage = header(messageLength: UInt32(FrameConstants.maxMessageBytes + 1))
        XCTAssertThrowsError(try FrameCodec.decodeHeader(tooBigMessage, at: 0)) { error in
            XCTAssertEqual(
                error as? FrameError,
                FrameError.messageTooLarge(FrameConstants.maxMessageBytes + 1)
            )
        }

        let tooBigBinary = header(binaryLength: UInt32(FrameConstants.maxBinaryBytes + 1))
        XCTAssertThrowsError(try FrameCodec.decodeHeader(tooBigBinary, at: 0)) { error in
            XCTAssertEqual(
                error as? FrameError,
                FrameError.binaryTooLarge(FrameConstants.maxBinaryBytes + 1)
            )
        }
    }

    func testDecoderReassemblesFramesSplitAcrossChunks() throws {
        let first = try FrameCodec.encode(Frame(messageText: "{\"n\":1}", binary: [9, 9]))
        let second = try FrameCodec.encode(Frame(messageText: "{\"n\":2}"))
        let stream = first + second

        let decoder = FrameDecoder()
        var messages = [String]()
        var index = 0
        while index < stream.count {
            let end = min(index + 3, stream.count)
            decoder.push(Array(stream[index..<end]))
            index = end
            while let frame = try decoder.next() {
                messages.append(frame.messageText)
            }
        }

        XCTAssertEqual(messages, ["{\"n\":1}", "{\"n\":2}"])
        XCTAssertEqual(decoder.bufferedByteCount, 0)
    }

    func testDecoderRoundTripsBinaryPayloads() throws {
        let payload = (0..<4096).map { UInt8($0 % 256) }
        let encoded = try FrameCodec.encode(Frame(messageText: "{\"op\":\"echo\"}", binary: payload))

        let decoder = FrameDecoder()
        decoder.push(encoded)
        let frame = try decoder.next()

        XCTAssertEqual(frame?.binary, payload)
        XCTAssertEqual(frame?.messageText, "{\"op\":\"echo\"}")
    }

    func testDecoderPoisonsItselfAfterAMalformedHeader() throws {
        let decoder = FrameDecoder()
        decoder.push(header(magic: [0, 0, 0, 0]))
        XCTAssertThrowsError(try decoder.next())
        XCTAssertTrue(decoder.isPoisoned)

        // A valid frame afterwards must still be refused: the stream is no
        // longer known to be frame-aligned.
        let valid = try FrameCodec.encode(Frame(messageText: "{\"n\":1}"))
        decoder.push(valid)
        XCTAssertThrowsError(try decoder.next())
    }

    func testDecoderWaitsForAnIncompleteFrame() throws {
        let encoded = try FrameCodec.encode(Frame(messageText: "{\"n\":1}", binary: [1, 2, 3, 4]))
        let decoder = FrameDecoder()

        decoder.push(Array(encoded[0..<(encoded.count - 1)]))
        XCTAssertNil(try decoder.next())

        decoder.push([encoded[encoded.count - 1]])
        XCTAssertNotNil(try decoder.next())
    }

    func testEncoderRefusesAnEmptyMessage() {
        XCTAssertThrowsError(try FrameCodec.encode(Frame(message: []))) { error in
            XCTAssertEqual(error as? FrameError, FrameError.emptyMessage)
        }
    }
}
