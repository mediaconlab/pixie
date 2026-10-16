import CoreGraphics
import Foundation
import ImageIO
import PixieCore
import Vision

/// Pure-ish image work for screen frames. Everything here is synchronous and thread-safe, and is
/// called from a detached task so the main thread never blocks on OCR or JPEG encoding.
enum FrameProcessor {
    struct Output: @unchecked Sendable {
        let dataURL: String
        let width: Int
        let height: Int
        let hash: AverageHash?
    }

    /// Downscales so the longest side is ≤ `maxSide`, encodes JPEG at `quality`, returns a data URL.
    static func encode(_ image: CGImage, maxSide: Int = 768, quality: Double = 0.6) -> Output? {
        let scaled = downscale(image, maxSide: maxSide) ?? image
        // ImageIO is thread-safe (unlike AppKit image reps), so this can run off the main thread.
        let buffer = NSMutableData()
        guard let dest = CGImageDestinationCreateWithData(buffer as CFMutableData, "public.jpeg" as CFString, 1, nil) else {
            return nil
        }
        let props = [kCGImageDestinationLossyCompressionQuality as String: quality] as CFDictionary
        CGImageDestinationAddImage(dest, scaled, props)
        guard CGImageDestinationFinalize(dest) else { return nil }
        let jpeg = Data(referencing: buffer)
        return Output(dataURL: "data:image/jpeg;base64," + jpeg.base64EncodedString(),
                      width: scaled.width, height: scaled.height, hash: averageHash(scaled))
    }

    static func downscale(_ image: CGImage, maxSide: Int) -> CGImage? {
        let w = image.width, h = image.height
        let longest = max(w, h)
        guard longest > maxSide else { return image }
        let k = Double(maxSide) / Double(longest)
        let nw = max(1, Int((Double(w) * k).rounded()))
        let nh = max(1, Int((Double(h) * k).rounded()))
        guard let ctx = CGContext(data: nil, width: nw, height: nh, bitsPerComponent: 8, bytesPerRow: 0,
                                  space: CGColorSpaceCreateDeviceRGB(),
                                  bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue) else { return nil }
        ctx.interpolationQuality = .medium
        ctx.draw(image, in: CGRect(x: 0, y: 0, width: nw, height: nh))
        return ctx.makeImage()
    }

    /// 16x16 grayscale average hash.
    static func averageHash(_ image: CGImage) -> AverageHash? {
        var pixels = [UInt8](repeating: 0, count: 256)
        let ok: Bool = pixels.withUnsafeMutableBytes { buf -> Bool in
            guard let base = buf.baseAddress,
                  let ctx = CGContext(data: base, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 16,
                                      space: CGColorSpaceCreateDeviceGray(),
                                      bitmapInfo: CGImageAlphaInfo.none.rawValue) else { return false }
            ctx.interpolationQuality = .low
            ctx.draw(image, in: CGRect(x: 0, y: 0, width: 16, height: 16))
            return true
        }
        return ok ? AverageHash(gray: pixels) : nil
    }

    /// On-device OCR (fast level), then redaction + truncation to 4000 chars.
    static func recognizeText(_ image: CGImage) -> String {
        let request = VNRecognizeTextRequest()
        request.recognitionLevel = .fast
        request.usesLanguageCorrection = false
        let handler = VNImageRequestHandler(cgImage: image, options: [:])
        do {
            try handler.perform([request])
        } catch {
            return ""
        }
        let observations = request.results ?? []
        // Sort top-to-bottom, then left-to-right (Vision uses a bottom-left origin).
        let sorted = observations.sorted { a, b in
            let ay = a.boundingBox.midY, by = b.boundingBox.midY
            if abs(ay - by) > 0.01 { return ay > by }
            return a.boundingBox.minX < b.boundingBox.minX
        }
        var lines: [String] = []
        var total = 0
        for obs in sorted {
            guard let s = obs.topCandidates(1).first?.string, !s.isEmpty else { continue }
            lines.append(s)
            total += s.count + 1
            if total > 12_000 { break }
        }
        return Redactor.redact(lines.joined(separator: "\n"))
    }
}
