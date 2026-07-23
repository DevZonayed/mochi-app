// ScreenCaptureController — Phase 3D1 view-only screen capture (Section C.10).
//
// A public-API ScreenCaptureKit adapter that captures ONLY a configured display,
// encodes each frame as JPEG, and hands it to an injected sink. It NEVER captures
// audio, never shows the cursor by default, never enumerates window titles for the
// remote, and exposes NO input/pointer/keyboard path — it is receive-nothing,
// produce-frames-only. Screen Recording permission is checked with the PUBLIC
// non-prompting preflight API; the product start path may request it (with a truthful
// status + a System Settings CTA), but tests must never prompt.
//
// Availability: gated to macOS 14 (the app's deployment floor, see Package.swift
// `.macOS(.v14)`). On older systems every entry point returns `.unsupported`.

import Foundation
import CoreGraphics
import CoreImage
import CoreMedia

#if canImport(ScreenCaptureKit)
import ScreenCaptureKit
#endif

/// The permission state, mirrored to the brain as a truthful status.
enum ScreenCapturePermission: String {
    case granted
    case denied
    case undetermined
    case unsupported
}

/// A configured capture source (one display). `id` is the opaque source-policy id
/// the host binds to the grant; the remote references only this, never a window.
struct ScreenCaptureSource {
    let id: String        // e.g. "display:1" — the sourcePolicyId
    let displayID: UInt32
    let label: String     // human name, e.g. "Built-in Retina Display · 1512×982"
    let width: Int
    let height: Int
}

struct ScreenCaptureStartConfig {
    let sourceID: String
    let maxDimension: Int       // aspect-fit longest edge (<= 1280)
    let fps: Int                // 2...60
    let showsCursor: Bool       // default false
    let jpegQuality: CGFloat    // 0...1, adaptive
}

enum ScreenCaptureStartError: Error {
    case unsupported
    case permission
    case sourceUnavailable
    case alreadyRunning
    case failed(String)
}

/// Public preflight — NEVER prompts. Uses the CoreGraphics preflight API.
func screenCapturePermissionState() -> ScreenCapturePermission {
    if #available(macOS 14.0, *) {
        // CGPreflightScreenCaptureAccess returns whether access is already granted,
        // WITHOUT presenting the system prompt.
        return CGPreflightScreenCaptureAccess() ? .granted : .undetermined
    }
    return .unsupported
}

#if canImport(ScreenCaptureKit)

@available(macOS 14.0, *)
final class ScreenCaptureController: NSObject, SCStreamOutput, SCStreamDelegate {
    /// Injected frame sink: (jpegData, captureTimestampMillis). Bounded, latest-only
    /// at the consumer; this controller never buffers a backlog.
    var onFrame: ((Data, Double) -> Void)?
    /// Injected error sink: a bounded, generic reason (no titles/paths).
    var onError: ((String) -> Void)?

    private var stream: SCStream?
    private let ciContext = CIContext(options: [.useSoftwareRenderer: false])
    private let sampleQueue = DispatchQueue(label: "ai.maestro.screencapture.samples")
    private var running = false
    private var jpegQuality: CGFloat = 0.6
    private var lastEmit: CFTimeInterval = 0
    private var minInterval: CFTimeInterval = 1.0 / 8.0

    /// List the capturable displays (no windows — view-only, display sources only).
    func listSources() async throws -> [ScreenCaptureSource] {
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        return content.displays.map { d in
            ScreenCaptureSource(
                id: "display:\(d.displayID)",
                displayID: d.displayID,
                label: "Display \(d.displayID) · \(d.width)×\(d.height)",
                width: d.width,
                height: d.height
            )
        }
    }

    func isSourceAvailable(_ sourceID: String) async -> Bool {
        (try? await listSources().contains { $0.id == sourceID }) ?? false
    }

    /// Start capturing the configured display. Returns the negotiated output size.
    func start(_ config: ScreenCaptureStartConfig) async throws -> (width: Int, height: Int) {
        guard !running else { throw ScreenCaptureStartError.alreadyRunning }
        guard screenCapturePermissionState() == .granted else { throw ScreenCaptureStartError.permission }

        let sources = try await listSources()
        guard let source = sources.first(where: { $0.id == config.sourceID }) else {
            throw ScreenCaptureStartError.sourceUnavailable
        }
        let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
        guard let display = content.displays.first(where: { $0.displayID == source.displayID }) else {
            throw ScreenCaptureStartError.sourceUnavailable
        }

        // Aspect-fit into maxDimension (<= 1280).
        let maxDim = max(64, min(config.maxDimension, 1280))
        let scale = min(1.0, Double(maxDim) / Double(max(display.width, display.height)))
        let outW = max(16, Int((Double(display.width) * scale).rounded()))
        let outH = max(16, Int((Double(display.height) * scale).rounded()))

        let filter = SCContentFilter(display: display, excludingApplications: [], exceptingWindows: [])
        let cfg = SCStreamConfiguration()
        cfg.width = outW
        cfg.height = outH
        cfg.showsCursor = config.showsCursor          // default false
        cfg.capturesAudio = false                     // NEVER audio
        cfg.pixelFormat = kCVPixelFormatType_32BGRA
        cfg.queueDepth = 5                             // small — latest-frame only, a touch deeper for 30fps
        let fps = max(2, min(config.fps, 60))          // real-time band: up to 60fps (was hard-capped at 10)
        cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))

        self.jpegQuality = max(0.2, min(config.jpegQuality, 0.9))
        self.minInterval = 1.0 / Double(fps)

        let stream = SCStream(filter: filter, configuration: cfg, delegate: self)
        try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: sampleQueue)
        try await stream.startCapture()
        self.stream = stream
        self.running = true
        return (width: outW, height: outH)
    }

    func stop() async {
        running = false
        if let s = stream {
            try? await s.stopCapture()
        }
        stream = nil
    }

    // MARK: - SCStreamOutput

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard running, type == .screen, sampleBuffer.isValid else { return }
        // Adaptive frame pacing: never emit faster than the target interval.
        let now = CACurrentMediaTimeShim()
        if now - lastEmit < minInterval { return }
        guard let pixelBuffer = CMSampleBufferGetImageBuffer(sampleBuffer) else { return }
        let ci = CIImage(cvImageBuffer: pixelBuffer)
        let colorSpace = CGColorSpaceCreateDeviceRGB()
        guard let jpeg = ciContext.jpegRepresentation(of: ci, colorSpace: colorSpace, options: [
            kCGImageDestinationLossyCompressionQuality as CIImageRepresentationOption: jpegQuality
        ]) else { return }
        lastEmit = now
        let ts = Date().timeIntervalSince1970 * 1000.0
        onFrame?(jpeg, ts)
    }

    // MARK: - SCStreamDelegate

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        running = false
        self.stream = nil
        onError?("capture stopped")
    }
}

#endif

/// A tiny monotonic-clock shim so the sample path doesn't import QuartzCore just for
/// CACurrentMediaTime (available via CoreVideo's display link elsewhere).
func CACurrentMediaTimeShim() -> CFTimeInterval {
    var ts = timespec()
    clock_gettime(CLOCK_MONOTONIC, &ts)
    return CFTimeInterval(ts.tv_sec) + CFTimeInterval(ts.tv_nsec) / 1_000_000_000.0
}
