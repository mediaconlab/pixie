import Foundation

/// Pure redaction of OCR text before it leaves the Mac (PROTOCOL.md `screen.frame.ocr`).
/// No AppKit, no state: `Redactor.redact(_:)` is a pure function and is unit-tested.
public enum Redactor {
    public static let mask = "‹redacted›"
    public static let maxLength = 4000

    /// Redacts secrets, then truncates to `maxLength` characters.
    public static func redact(_ input: String, maxLength: Int = Redactor.maxLength) -> String {
        var lines: [String] = []
        for rawLine in input.components(separatedBy: "\n") {
            lines.append(redactLine(rawLine))
        }
        var text = lines.joined(separator: "\n")
        text = redactTokens(text)
        text = redactCardNumbers(text)
        if text.count > maxLength {
            text = String(text.prefix(maxLength))
        }
        return text
    }

    // MARK: Line rules

    private static let otpContext = try! NSRegularExpression(
        pattern: "\\b(codes?|otp|passcode|one[- ]?time|verification|verify|2fa|pin)\\b",
        options: [.caseInsensitive])
    private static let otpDigits = try! NSRegularExpression(pattern: "(?<![0-9])[0-9]{4,8}(?![0-9])", options: [])

    static func redactLine(_ line: String) -> String {
        // Any line mentioning a password is dropped wholesale.
        if line.range(of: "password", options: .caseInsensitive) != nil
            || line.range(of: "passwd", options: .caseInsensitive) != nil {
            return mask
        }
        // 4–8 digit numbers on a line that talks about a code / OTP.
        if matches(otpContext, line) {
            return replace(otpDigits, in: line, with: mask)
        }
        return line
    }

    // MARK: Token rules

    private static let tokenPatterns: [NSRegularExpression] = [
        // OpenAI / Anthropic style keys: sk-..., sk-ant-..., sk-proj-...
        "sk-[A-Za-z0-9_\\-]{16,}",
        // GitHub tokens
        "(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}",
        "github_pat_[A-Za-z0-9_]{20,}",
        // AWS access key IDs
        "(?:AKIA|ASIA)[0-9A-Z]{16}",
        // Slack tokens
        "xox[abposr]-[A-Za-z0-9\\-]{10,}",
        // Bearer tokens in headers
        "(?i:bearer)\\s+[A-Za-z0-9._~+/=\\-]{16,}",
        // JWTs
        "eyJ[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}\\.[A-Za-z0-9_\\-]{8,}",
        // Long hex strings (≥ 32)
        "(?<![A-Za-z0-9])[A-Fa-f0-9]{32,}(?![A-Za-z0-9])",
        // Long base64/base64url blobs (≥ 32) containing at least one digit and one letter
        "(?<![A-Za-z0-9+/_\\-])(?=[A-Za-z0-9+/_\\-]*[0-9])(?=[A-Za-z0-9+/_\\-]*[A-Za-z])[A-Za-z0-9+/_\\-]{32,}={0,2}",
    ].map { try! NSRegularExpression(pattern: $0, options: []) }

    static func redactTokens(_ text: String) -> String {
        var out = text
        for re in tokenPatterns {
            out = replace(re, in: out, with: mask)
        }
        return out
    }

    // MARK: Card numbers (13–19 digits, optional single space/dash separators, Luhn-valid)

    private static let cardCandidate = try! NSRegularExpression(
        pattern: "(?<![0-9])[0-9](?:[ \\-]?[0-9]){12,18}(?![0-9])", options: [])

    static func redactCardNumbers(_ text: String) -> String {
        let ns = text as NSString
        let matches = cardCandidate.matches(in: text, options: [], range: NSRange(location: 0, length: ns.length))
        if matches.isEmpty { return text }
        let result = NSMutableString(string: text)
        // Replace from the end so earlier ranges stay valid.
        for m in matches.reversed() {
            let candidate = ns.substring(with: m.range)
            let digits = candidate.filter { $0 >= "0" && $0 <= "9" }
            if digits.count >= 13 && digits.count <= 19 && luhnValid(String(digits)) {
                result.replaceCharacters(in: m.range, with: mask)
            }
        }
        return result as String
    }

    /// Standard Luhn checksum over a string of ASCII digits.
    public static func luhnValid(_ digits: String) -> Bool {
        var sum = 0
        var double = false
        var count = 0
        for ch in digits.reversed() {
            guard let d = ch.wholeNumberValue, ch.isASCII else { return false }
            var v = d
            if double {
                v *= 2
                if v > 9 { v -= 9 }
            }
            sum += v
            double.toggle()
            count += 1
        }
        return count > 0 && sum % 10 == 0
    }

    // MARK: Helpers

    private static func matches(_ re: NSRegularExpression, _ s: String) -> Bool {
        re.firstMatch(in: s, options: [], range: NSRange(location: 0, length: (s as NSString).length)) != nil
    }

    private static func replace(_ re: NSRegularExpression, in s: String, with replacement: String) -> String {
        re.stringByReplacingMatches(
            in: s, options: [],
            range: NSRange(location: 0, length: (s as NSString).length),
            withTemplate: NSRegularExpression.escapedTemplate(for: replacement))
    }
}
