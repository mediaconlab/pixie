import AppKit
import PixieCore
import SwiftUI

/// `Pixie --render-snapshots <dir>` draws the real character (the same `CharacterFrame` the overlay uses)
/// in every emotion, phase and behaviour to PNG files, then exits. Used by CI to show what Pixie looks like.
@MainActor
enum SnapshotRenderer {
    static func runIfRequested() -> Bool {
        let args = CommandLine.arguments
        guard let i = args.firstIndex(of: "--render-snapshots") else { return false }
        let dir = i + 1 < args.count ? args[i + 1] : "snapshots"
        render(to: URL(fileURLWithPath: dir, isDirectory: true))
        return true
    }

    private static let size: CGFloat = 160

    static func render(to dir: URL) {
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        // Emotions (awake, idle).
        for e in Emotion.allCases {
            let m = AvatarModel()
            m.setEmotion(e, intensity: 0.9)
            write(m, after: 3.0, name: "emotion-\(e.rawValue)", dir: dir)
        }

        // Behaviours, each in the phase and surroundings that would trigger it.
        for b in PetBehaviour.allCases {
            let m = AvatarModel()
            switch b {
            case .nap: m.setPetPhase(.napping)
            case .sleepCurled: m.setPetPhase(.asleep)
            case .curlNearCursor, .yawnStretch: m.setPetPhase(.sleepy)
            case .lookOutWindow: m.windowStyle = .rain
            case .festiveWiggle: m.festive = true
            default: break
            }
            m.setPetBehaviour(b)
            // Two moments of each motion so movement shows.
            write(m, after: 1.2, name: "behaviour-\(b.rawValue)-a", dir: dir)
            write(m, after: 2.1, name: "behaviour-\(b.rawValue)-b", dir: dir)
        }

        // Window moods.
        for (style, label) in [(PetWindowStyle.sunset, "sunset"), (.storm, "storm"), (.night, "night"), (.snow, "snow")] {
            let m = AvatarModel()
            m.windowStyle = style
            m.setPetBehaviour(.lookOutWindow)
            write(m, after: 1.5, name: "window-\(label)", dir: dir)
        }

        // Short reactions (cues).
        for c in PetCue.allCases {
            let m = AvatarModel()
            m.playCue(c)
            write(m, after: 0.35, name: "cue-\(c.rawValue)", dir: dir)
        }
    }

    private static func write(_ m: AvatarModel, after seconds: TimeInterval, name: String, dir: URL) {
        let pose = Pose.compute(m, now: Date().addingTimeInterval(seconds))
        let view = CharacterFrame(pose: pose, size: size, eyeIndicator: false, listening: false, connected: true)
            .frame(width: size * 1.6, height: size * 1.6)
            .background(Color(red: 0.96, green: 0.96, blue: 0.95))
        let renderer = ImageRenderer(content: view)
        renderer.scale = 2
        guard let cg = renderer.cgImage else {
            FileHandle.standardError.write(Data("snapshot failed: \(name)\n".utf8))
            return
        }
        let rep = NSBitmapImageRep(cgImage: cg)
        guard let png = rep.representation(using: .png, properties: [:]) else { return }
        try? png.write(to: dir.appendingPathComponent("\(name).png"))
    }
}
