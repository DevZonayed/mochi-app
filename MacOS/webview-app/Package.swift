// swift-tools-version: 6.0
import PackageDescription

let package = Package(
    name: "MaestroWebKit",
    platforms: [.macOS(.v14)],
    products: [
        .executable(name: "MaestroWebKit", targets: ["MaestroWebKit"]),
    ],
    targets: [
        .executableTarget(
            name: "MaestroWebKit",
            path: "Sources/MaestroWebKit",
            swiftSettings: [
                .swiftLanguageMode(.v5),
            ]
        ),
    ]
)
