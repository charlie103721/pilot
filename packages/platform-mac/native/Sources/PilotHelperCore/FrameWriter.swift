import Foundation

/// Serialises frame writes to one file handle (PR-015).
///
/// ## Why this exists now and did not before
///
/// Through PR-011 the helper only ever wrote from one place: the stdio request
/// loop, one response per request, strictly ordered. Push-to-talk breaks that.
/// The `CGEventTap` runs on its own thread (it must — see `HotkeyTap.swift`)
/// and produces frames that have to reach the host in milliseconds, so two
/// threads now write to the same descriptor.
///
/// Two interleaved `write(2)` calls on a length-prefixed protocol do not
/// produce a garbled message; they produce a **desynchronised stream**, and the
/// host reacts to that by killing the helper (PR-003: "the byte stream is no
/// longer known to be frame-aligned"). So every frame is encoded first and
/// written whole under a lock. The lock is held across the write, which is what
/// makes the guarantee — a partial frame can never be followed by another
/// frame's bytes.
///
/// PR-011 explicitly chose snapshot-diffing for windows to avoid needing this.
/// That reasoning still holds for windows; it does not hold for a key press,
/// where a poll interval short enough to be usable would be a permanent
/// several-times-a-second round trip. The cost is this one file.
///
/// A write failure is sticky: once the pipe is gone, every later write is a
/// no-op rather than a repeated `SIGPIPE`-adjacent surprise. The caller checks
/// `hasFailed` and exits, and Pilot's supervisor restarts the helper.
public final class FrameWriter {
    private let handle: FileHandle
    private let lock = NSLock()
    private var failed = false

    public init(handle: FileHandle) {
        self.handle = handle
    }

    public var hasFailed: Bool {
        lock.lock()
        defer { lock.unlock() }
        return failed
    }

    /// Encodes and writes one frame. Returns false when the frame could not be
    /// encoded or the stream is already broken.
    @discardableResult
    public func write(_ frame: Frame) -> Bool {
        let bytes: [UInt8]
        do {
            bytes = try FrameCodec.encode(frame)
        } catch {
            return false
        }

        lock.lock()
        defer { lock.unlock() }
        if failed {
            return false
        }
        // The throwing variant, not `FileHandle.write(_:)`: the non-throwing one
        // raises an Objective-C exception on a broken pipe, which in Swift is a
        // crash rather than an error. Available since macOS 10.15.4, and this
        // package targets macOS 13.
        do {
            try handle.write(contentsOf: Data(bytes))
        } catch {
            failed = true
            return false
        }
        return true
    }
}
