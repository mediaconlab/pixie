// swift-tools-version:5.10
import PackageDescription

// Pixie for macOS 14+ (Apple Silicon). No third-party dependencies.
//
//  PixieCore  – pure Foundation code (protocol models, redactor, image hash, backoff, queue,
//               activity classifier, capture guard). Unit-tested with `swift test`.
//  Pixie      – the AppKit/SwiftUI app.
let package = Package(
    name: "Pixie",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Pixie", targets: ["Pixie"])
    ],
    targets: [
        .target(
            name: "PixieCore",
            path: "Sources/PixieCore"
        ),
        .executableTarget(
            name: "Pixie",
            dependencies: ["PixieCore"],
            path: "Sources/Pixie",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("SwiftUI"),
                .linkedFramework("ScreenCaptureKit"),
                .linkedFramework("Vision"),
                .linkedFramework("Speech"),
                .linkedFramework("AVFoundation"),
                .linkedFramework("CoreImage"),
                .linkedFramework("Security"),
            ]
        ),
        .testTarget(
            name: "PixieCoreTests",
            dependencies: ["PixieCore"],
            path: "Tests/PixieCoreTests"
        ),
    ],
    swiftLanguageVersions: [.v5]
)
