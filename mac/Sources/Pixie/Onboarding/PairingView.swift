import AppKit
import CoreImage
import CoreImage.CIFilterBuiltins
import PixieCore
import SwiftUI

enum QRCode {
    /// Crisp QR code image for `text` (nearest-neighbour scaled).
    static func image(for text: String, scale: CGFloat = 10) -> NSImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage else { return nil }
        let scaled = output.transformed(by: CGAffineTransform(scaleX: scale, y: scale))
        let context = CIContext(options: nil)
        guard let cg = context.createCGImage(scaled, from: scaled.extent) else { return nil }
        return NSImage(cgImage: cg, size: NSSize(width: scaled.extent.width, height: scaled.extent.height))
    }
}

@MainActor
final class PairingModel: ObservableObject {
    @Published var code: String?
    @Published var link: String?
    @Published var expiresAt: Date?
    @Published var qr: NSImage?
    @Published var devices: [DeviceRecord] = []
    @Published var error: String?
    @Published var busy = false

    private let api: @MainActor () -> BrainAPI?
    let ownDeviceID: String

    init(api: @escaping @MainActor () -> BrainAPI?, ownDeviceID: String) {
        self.api = api
        self.ownDeviceID = ownDeviceID
    }

    func startPairing() {
        guard let api = api() else { error = BrainAPIError.notSignedIn.errorDescription; return }
        busy = true
        error = nil
        Task { @MainActor in
            do {
                let r = try await api.pairStart()
                code = r.code
                link = r.link
                expiresAt = Date(timeIntervalSince1970: r.expires_at / 1000)
                qr = QRCode.image(for: r.link)
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
            busy = false
        }
    }

    func refreshDevices() {
        guard let api = api() else { return }
        Task { @MainActor in
            do {
                devices = try await api.devices()
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }

    func remove(_ d: DeviceRecord) {
        guard let api = api() else { return }
        Task { @MainActor in
            do {
                try await api.removeDevice(id: d.id)
                devices.removeAll { $0.id == d.id }
            } catch {
                self.error = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
            }
        }
    }
}

/// "Pair a device…": 6-digit code, QR of the `pixie://pair` link, and the device list.
struct PairingView: View {
    @ObservedObject var model: PairingModel

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            Text("Pair a phone or editor")
                .font(.system(size: 18, weight: .bold, design: .rounded))
            HStack(alignment: .top, spacing: 20) {
                codeSection
                qrSection
            }
            if let error = model.error {
                Text(error).font(.caption).foregroundStyle(Color.red)
            }
            Divider()
            devicesSection
        }
        .padding(22)
        .frame(width: 520)
        .onAppear {
            if model.code == nil { model.startPairing() }
            model.refreshDevices()
        }
    }

    private var codeSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Code").font(.caption).foregroundStyle(.secondary)
            Text(spaced(model.code ?? "------"))
                .font(.system(size: 40, weight: .heavy, design: .monospaced))
                .textSelection(.enabled)
            if let exp = model.expiresAt {
                HStack(spacing: 4) {
                    Text("Expires")
                    Text(exp, style: .relative)
                }
                .font(.caption)
                .foregroundStyle(.secondary)
            }
            Text("On Android, scan the QR with your camera. In VS Code, run “Pixie: Pair” and type the brain URL and this code.")
                .font(.system(size: 11))
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Button(model.code == nil ? "Get a code" : "New code") { model.startPairing() }
                .disabled(model.busy)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var qrSection: some View {
        Group {
            if let qr = model.qr {
                Image(nsImage: qr)
                    .interpolation(.none)
                    .resizable()
                    .frame(width: 180, height: 180)
                    .padding(8)
                    .background(RoundedRectangle(cornerRadius: 12).fill(Color.white))
            } else {
                RoundedRectangle(cornerRadius: 12)
                    .fill(Color.primary.opacity(0.06))
                    .frame(width: 196, height: 196)
                    .overlay(ProgressView())
            }
        }
    }

    private var devicesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("Your devices").font(.system(size: 13, weight: .semibold))
                Spacer()
                Button {
                    model.refreshDevices()
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
            }
            if model.devices.isEmpty {
                Text("No devices yet.").font(.caption).foregroundStyle(.secondary)
            }
            ForEach(model.devices) { d in
                HStack(spacing: 10) {
                    Image(systemName: icon(for: d.kind))
                        .frame(width: 20)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(d.name ?? d.id).font(.system(size: 12.5, weight: .medium))
                        Text(subtitle(for: d)).font(.system(size: 10.5)).foregroundStyle(.secondary)
                    }
                    Spacer()
                    Circle()
                        .fill((d.online ?? false) ? Color.green : Color.gray.opacity(0.5))
                        .frame(width: 8, height: 8)
                    if d.id != model.ownDeviceID {
                        Button("Remove", role: .destructive) { model.remove(d) }
                            .controlSize(.small)
                    } else {
                        Text("This Mac").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
        }
    }

    private func spaced(_ code: String) -> String {
        guard code.count == 6 else { return code }
        return String(code.prefix(3)) + " " + String(code.suffix(3))
    }

    private func icon(for kind: String?) -> String {
        switch kind ?? "" {
        case "mac": return "laptopcomputer"
        case "android": return "iphone"
        case "ide": return "chevron.left.forwardslash.chevron.right"
        default: return "questionmark.circle"
        }
    }

    private func subtitle(for d: DeviceRecord) -> String {
        var parts: [String] = [d.kind ?? "device"]
        if let ls = d.last_seen, ls > 0 {
            let f = RelativeDateTimeFormatter()
            parts.append("seen " + f.localizedString(for: Date(timeIntervalSince1970: ls / 1000), relativeTo: Date()))
        }
        return parts.joined(separator: " · ")
    }
}
