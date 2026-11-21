import SwiftUI
import VisionKit
import EmperorCore

struct QRScanner: UIViewControllerRepresentable {
    let scanned: (String) -> Void
    func makeCoordinator() -> Coordinator { Coordinator(scanned) }
    func makeUIViewController(context: Context) -> DataScannerViewController {
        let controller = DataScannerViewController(recognizedDataTypes: [.barcode(symbologies: [.qr])], qualityLevel: .balanced, recognizesMultipleItems: false, isHighFrameRateTrackingEnabled: false, isPinchToZoomEnabled: true, isGuidanceEnabled: true, isHighlightingEnabled: true)
        controller.delegate = context.coordinator
        try? controller.startScanning()
        return controller
    }
    func updateUIViewController(_ uiViewController: DataScannerViewController, context: Context) {}
    static func dismantleUIViewController(_ uiViewController: DataScannerViewController, coordinator: Coordinator) { uiViewController.stopScanning() }
    final class Coordinator: NSObject, DataScannerViewControllerDelegate {
        let scanned: (String) -> Void
        private var finished = false
        init(_ scanned: @escaping (String) -> Void) { self.scanned = scanned }
        func dataScanner(_ dataScanner: DataScannerViewController, didAdd addedItems: [RecognizedItem], allItems: [RecognizedItem]) {
            for item in addedItems { if case .barcode(let code) = item, let text = code.payloadStringValue, !finished, (try? ServerAddress.parse(text)) != nil { finished = true; scanned(text) } }
        }
    }
}
