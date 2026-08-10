// swift-tools-version:5.9
import PackageDescription

// The embedded helper Pilot spawns (system-design §4). PR-003 builds only the
// transport: framed stdio, `health` and `echo`. ScreenCaptureKit,
// Accessibility and Speech arrive from PR-011 onward.
let package = Package(
    name: "PilotHelper",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        // Product and target share a name on purpose: SwiftPM then writes the
        // executable to `.build/<configuration>/PilotHelper` under either
        // naming rule, which is the path `src/helper-binary.ts` looks for.
        .executable(name: "PilotHelper", targets: ["PilotHelper"]),
        .library(name: "PilotHelperCore", targets: ["PilotHelperCore"]),
    ],
    targets: [
        .target(
            name: "PilotHelperCore"
        ),
        .executableTarget(
            name: "PilotHelper",
            dependencies: ["PilotHelperCore"]
        ),
        .testTarget(
            name: "PilotHelperCoreTests",
            dependencies: ["PilotHelperCore"]
        ),
    ]
)
