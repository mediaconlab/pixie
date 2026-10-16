import CoreAudio
import CoreMediaIO
import Foundation

/// Read-only "is someone using the mic / camera" probes. Neither reads audio or video, so neither needs the
/// Microphone or Camera permission. Every failure reads as "not in use".
enum PixieDeviceProbes {
    // MARK: Microphone (CoreAudio)

    /// The default input device, or nil when there is none.
    static func defaultInputDevice() -> AudioDeviceID? {
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioHardwarePropertyDefaultInputDevice,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var device = AudioDeviceID(0)
        var size = UInt32(MemoryLayout<AudioDeviceID>.size)
        let status = AudioObjectGetPropertyData(AudioObjectID(kAudioObjectSystemObject), &addr, 0, nil, &size, &device)
        guard status == 0, device != 0 else { return nil }
        return device
    }

    /// Whether any process is running the default input device (a call, a recorder, dictation…).
    static func micInUse() -> Bool {
        guard let device = defaultInputDevice() else { return false }
        var addr = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
            mScope: kAudioObjectPropertyScopeGlobal,
            mElement: kAudioObjectPropertyElementMain
        )
        var running = UInt32(0)
        var size = UInt32(MemoryLayout<UInt32>.size)
        let status = AudioObjectGetPropertyData(device, &addr, 0, nil, &size, &running)
        return status == 0 && running != 0
    }

    // MARK: Camera (CoreMediaIO)

    private static func cmioAddress(_ selector: Int) -> CMIOObjectPropertyAddress {
        CMIOObjectPropertyAddress(
            mSelector: CMIOObjectPropertySelector(selector),
            mScope: CMIOObjectPropertyScope(kCMIOObjectPropertyScopeGlobal),
            mElement: CMIOObjectPropertyElement(0) // the main element
        )
    }

    /// All CoreMediaIO devices (cameras, including virtual ones).
    static func videoDevices() -> [CMIODeviceID] {
        var addr = cmioAddress(Int(kCMIOHardwarePropertyDevices))
        let system = CMIOObjectID(kCMIOObjectSystemObject)
        var size = UInt32(0)
        guard CMIOObjectGetPropertyDataSize(system, &addr, 0, nil, &size) == 0, size > 0 else { return [] }
        let count = Int(size) / MemoryLayout<CMIODeviceID>.size
        guard count > 0 else { return [] }
        var ids = [CMIODeviceID](repeating: 0, count: count)
        var used = UInt32(0)
        let status = ids.withUnsafeMutableBytes { buf -> OSStatus in
            CMIOObjectGetPropertyData(system, &addr, 0, nil, size, &used, buf.baseAddress!)
        }
        guard status == 0 else { return [] }
        let filled = min(count, Int(used) / MemoryLayout<CMIODeviceID>.size)
        return Array(ids.prefix(filled))
    }

    /// Whether any process is running any camera.
    static func cameraInUse() -> Bool {
        for device in videoDevices() {
            var addr = cmioAddress(Int(kCMIODevicePropertyDeviceIsRunningSomewhere))
            var running = UInt32(0)
            var used = UInt32(0)
            let size = UInt32(MemoryLayout<UInt32>.size)
            let status = CMIOObjectGetPropertyData(device, &addr, 0, nil, size, &used, &running)
            if status == 0 && running != 0 { return true }
        }
        return false
    }
}
