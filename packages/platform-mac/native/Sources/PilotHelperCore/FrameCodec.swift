import Foundation

/// Framed stdio wire format shared with the TypeScript host.
///
/// Header layout (16 bytes, all multi-byte integers big-endian):
///
///     offset  size  field
///          0     4  magic, ASCII "PILT"
///          4     1  protocolVersion (UInt8)
///          5     1  flags (UInt8) — reserved, must be 0
///          6     2  reserved (UInt16) — must be 0
///          8     4  messageLength (UInt32), UTF-8 JSON, must be > 0
///         12     4  binaryLength (UInt32), may be 0
///         16     …  message bytes, then binary bytes
///
/// Keep this in exact agreement with
/// `packages/platform-mac/src/protocol/frame.ts`.
public enum FrameConstants {
    public static let magic: [UInt8] = [0x50, 0x49, 0x4C, 0x54]  // "PILT"
    public static let protocolVersion: UInt8 = 1
    public static let headerByteLength = 16
    public static let maxMessageBytes = 1_048_576
    public static let maxBinaryBytes = 33_554_432
    public static var maxFrameBytes: Int {
        headerByteLength + maxMessageBytes + maxBinaryBytes
    }
}

public enum FrameError: Error, Equatable {
    case badMagic
    case unsupportedVersion(UInt8)
    case reservedBitsSet
    case emptyMessage
    case messageTooLarge(Int)
    case binaryTooLarge(Int)

    public var errorCode: String {
        switch self {
        case .unsupportedVersion:
            return "protocol-version-mismatch"
        case .messageTooLarge, .binaryTooLarge:
            return "payload-too-large"
        case .badMagic, .reservedBitsSet, .emptyMessage:
            return "invalid-request"
        }
    }

    public var errorDomain: String {
        switch self {
        case .messageTooLarge, .binaryTooLarge:
            return "policy"
        default:
            return "ipc"
        }
    }

    public var message: String {
        switch self {
        case .badMagic:
            return "Frame header has the wrong magic"
        case .unsupportedVersion(let version):
            return "Unsupported helper frame version \(version)"
        case .reservedBitsSet:
            return "Frame header uses reserved bits"
        case .emptyMessage:
            return "Frame header declares an empty message body"
        case .messageTooLarge(let length):
            return "Frame message body of \(length) bytes exceeds the protocol limit"
        case .binaryTooLarge(let length):
            return "Frame binary body of \(length) bytes exceeds the protocol limit"
        }
    }
}

public struct FrameHeader: Equatable {
    public let version: UInt8
    public let flags: UInt8
    public let messageLength: Int
    public let binaryLength: Int

    public var totalLength: Int {
        FrameConstants.headerByteLength + messageLength + binaryLength
    }
}

public struct Frame: Equatable {
    public let message: [UInt8]
    public let binary: [UInt8]

    public init(message: [UInt8], binary: [UInt8] = []) {
        self.message = message
        self.binary = binary
    }

    public init(messageText: String, binary: [UInt8] = []) {
        self.init(message: Array(messageText.utf8), binary: binary)
    }

    public var messageText: String {
        String(decoding: message, as: UTF8.self)
    }
}

public enum FrameCodec {
    /// Encodes one frame. Throws rather than emitting a frame the host would
    /// have to reject.
    public static func encode(_ frame: Frame) throws -> [UInt8] {
        if frame.message.isEmpty {
            throw FrameError.emptyMessage
        }
        if frame.message.count > FrameConstants.maxMessageBytes {
            throw FrameError.messageTooLarge(frame.message.count)
        }
        if frame.binary.count > FrameConstants.maxBinaryBytes {
            throw FrameError.binaryTooLarge(frame.binary.count)
        }

        var bytes = [UInt8]()
        bytes.reserveCapacity(
            FrameConstants.headerByteLength + frame.message.count + frame.binary.count)
        bytes.append(contentsOf: FrameConstants.magic)
        bytes.append(FrameConstants.protocolVersion)
        bytes.append(0)  // flags
        bytes.append(0)  // reserved high byte
        bytes.append(0)  // reserved low byte
        bytes.append(contentsOf: bigEndianBytes(UInt32(frame.message.count)))
        bytes.append(contentsOf: bigEndianBytes(UInt32(frame.binary.count)))
        bytes.append(contentsOf: frame.message)
        bytes.append(contentsOf: frame.binary)
        return bytes
    }

    /// Reads and validates a header from `bytes` starting at `offset`.
    /// `bytes` must hold at least `headerByteLength` bytes from `offset`.
    public static func decodeHeader(_ bytes: [UInt8], at offset: Int) throws -> FrameHeader {
        let magicEnd = offset + FrameConstants.magic.count
        if Array(bytes[offset..<magicEnd]) != FrameConstants.magic {
            throw FrameError.badMagic
        }

        let version = bytes[offset + 4]
        if version != FrameConstants.protocolVersion {
            throw FrameError.unsupportedVersion(version)
        }

        let flags = bytes[offset + 5]
        let reserved = readUInt16(bytes, at: offset + 6)
        if flags != 0 || reserved != 0 {
            throw FrameError.reservedBitsSet
        }

        let messageLength = Int(readUInt32(bytes, at: offset + 8))
        let binaryLength = Int(readUInt32(bytes, at: offset + 12))

        if messageLength == 0 {
            throw FrameError.emptyMessage
        }
        if messageLength > FrameConstants.maxMessageBytes {
            throw FrameError.messageTooLarge(messageLength)
        }
        if binaryLength > FrameConstants.maxBinaryBytes {
            throw FrameError.binaryTooLarge(binaryLength)
        }

        return FrameHeader(
            version: version,
            flags: flags,
            messageLength: messageLength,
            binaryLength: binaryLength
        )
    }

    static func bigEndianBytes(_ value: UInt32) -> [UInt8] {
        [
            UInt8((value >> 24) & 0xFF),
            UInt8((value >> 16) & 0xFF),
            UInt8((value >> 8) & 0xFF),
            UInt8(value & 0xFF),
        ]
    }

    static func readUInt16(_ bytes: [UInt8], at offset: Int) -> UInt16 {
        (UInt16(bytes[offset]) << 8) | UInt16(bytes[offset + 1])
    }

    static func readUInt32(_ bytes: [UInt8], at offset: Int) -> UInt32 {
        (UInt32(bytes[offset]) << 24)
            | (UInt32(bytes[offset + 1]) << 16)
            | (UInt32(bytes[offset + 2]) << 8)
            | UInt32(bytes[offset + 3])
    }
}

/// Incremental decoder over a byte stream delivered in arbitrary chunks.
///
/// The first malformed or oversized header poisons the decoder: a stream whose
/// framing is wrong cannot be resynchronised safely, so the helper exits and
/// lets the host's supervisor restart it.
public final class FrameDecoder {
    private var buffer: [UInt8] = []
    private var offset = 0
    private var failure: FrameError?

    public init() {}

    public var bufferedByteCount: Int {
        buffer.count - offset
    }

    public var isPoisoned: Bool {
        failure != nil
    }

    public func push(_ chunk: [UInt8]) {
        buffer.append(contentsOf: chunk)
    }

    /// Returns the next complete frame, or `nil` when more bytes are needed.
    public func next() throws -> Frame? {
        if let failure {
            throw failure
        }
        if bufferedByteCount < FrameConstants.headerByteLength {
            compact()
            return nil
        }

        let header: FrameHeader
        do {
            header = try FrameCodec.decodeHeader(buffer, at: offset)
        } catch let error as FrameError {
            failure = error
            throw error
        }

        if bufferedByteCount < header.totalLength {
            compact()
            return nil
        }

        let messageStart = offset + FrameConstants.headerByteLength
        let messageEnd = messageStart + header.messageLength
        let binaryEnd = messageEnd + header.binaryLength
        let frame = Frame(
            message: Array(buffer[messageStart..<messageEnd]),
            binary: header.binaryLength == 0 ? [] : Array(buffer[messageEnd..<binaryEnd])
        )
        offset = binaryEnd
        compact()
        return frame
    }

    private func compact() {
        if offset == 0 {
            return
        }
        if offset >= buffer.count {
            buffer.removeAll(keepingCapacity: true)
            offset = 0
            return
        }
        // Only pay for the copy once the consumed prefix is worth reclaiming.
        if offset > 65536 {
            buffer.removeFirst(offset)
            offset = 0
        }
    }
}
