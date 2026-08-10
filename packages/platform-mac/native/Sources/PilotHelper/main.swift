import Foundation
import PilotHelperCore

// The embedded helper Pilot spawns (system-design §4). It speaks the framed
// stdio protocol on stdin/stdout and nothing else: no ports, no sockets, no
// user-facing service. Diagnostics go to stderr, which Pilot captures for
// crash reports.
//
// Frames are read and written through `FileHandle`, which talks to the file
// descriptors directly — no line buffering and no newline translation, both of
// which would corrupt a binary payload.

let helperVersion = "0.1.0"

let server = HelperServer(helperVersion: helperVersion)
let status = HelperRuntime.run(server: server)
exit(status)
