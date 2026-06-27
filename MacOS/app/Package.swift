// swift-tools-version: 6.0
import PackageDescription

// The Maestro native macOS app (SwiftUI). Built as a SwiftPM executable so it can be
// compiled + verified with `swift build`; `package-app.sh` assembles the distributable
// `Maestro.app` bundle (Info.plist + the embedded `maestro-sidecar` binary + codesign).
let package = Package(
    name: "Maestro",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "Maestro", targets: ["Maestro"]),
    ],
    targets: [
        .executableTarget(
            name: "Maestro",
            path: "Sources/Maestro",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
    ]
)
