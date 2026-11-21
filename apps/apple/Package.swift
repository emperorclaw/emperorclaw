// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "EmperorCore",
    platforms: [.iOS(.v17), .watchOS(.v10), .macOS(.v14)],
    products: [.library(name: "EmperorCore", targets: ["EmperorCore"])],
    targets: [.target(name: "EmperorCore"), .testTarget(name: "EmperorCoreTests", dependencies: ["EmperorCore"])]
)
