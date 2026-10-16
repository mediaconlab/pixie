import Foundation
import PixieCore

enum BrainAPIError: LocalizedError {
    case badURL
    case notSignedIn
    case server(status: Int, code: String, message: String?)
    case decoding
    case transport(String)

    var errorDescription: String? {
        switch self {
        case .badURL: return "That brain URL doesn't look right. It should start with https://"
        case .notSignedIn: return "Pixie isn't signed in yet."
        case .server(let status, let code, let message):
            if code == "registration_closed" { return "This brain already has an owner. Ask them to pair this Mac instead." }
            return message ?? "Server error \(status): \(code)"
        case .decoding: return "Unexpected response from the brain."
        case .transport(let s): return s
        }
    }
}

/// REST calls from PROTOCOL.md §1. Stateless; pass base URL + token per call.
struct BrainAPI {
    let baseURL: URL
    let token: String?

    private func request(_ method: String, _ path: String, body: Data? = nil, auth: Bool = true) throws -> URLRequest {
        guard let url = URL(string: baseURL.absoluteString + path) else { throw BrainAPIError.badURL }
        var req = URLRequest(url: url)
        req.httpMethod = method
        req.timeoutInterval = 20
        req.setValue("application/json", forHTTPHeaderField: "Accept")
        if let body {
            req.httpBody = body
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        }
        if auth {
            guard let token, !token.isEmpty else { throw BrainAPIError.notSignedIn }
            req.setValue("Bearer \(token)", forHTTPHeaderField: "Authorization")
        }
        return req
    }

    private func send<T: Decodable>(_ req: URLRequest, as type: T.Type) async throws -> T {
        let result: (Data, URLResponse)
        do {
            result = try await URLSession.shared.data(for: req)
        } catch {
            throw BrainAPIError.transport(error.localizedDescription)
        }
        let data = result.0
        let response = result.1
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        guard (200..<300).contains(status) else {
            if let err = try? JSONDecoder().decode(APIErrorBody.self, from: data) {
                throw BrainAPIError.server(status: status, code: err.error, message: err.message)
            }
            throw BrainAPIError.server(status: status, code: "http_\(status)", message: nil)
        }
        guard let value = try? JSONDecoder().decode(T.self, from: data) else { throw BrainAPIError.decoding }
        return value
    }

    func register(userName: String, deviceName: String) async throws -> RegisterResponse {
        let body = try JSONEncoder().encode(RegisterRequest(name: userName, device: DeviceDescriptor(kind: "mac", name: deviceName)))
        return try await send(request("POST", "/v1/register", body: body, auth: false), as: RegisterResponse.self)
    }

    func pairStart() async throws -> PairStartResponse {
        try await send(request("POST", "/v1/pair/start", body: Data("{}".utf8)), as: PairStartResponse.self)
    }

    func devices() async throws -> [DeviceRecord] {
        try await send(request("GET", "/v1/devices"), as: DevicesResponse.self).devices
    }

    func removeDevice(id: String) async throws {
        let escaped = id.addingPercentEncoding(withAllowedCharacters: .urlPathAllowed) ?? id
        _ = try await send(request("DELETE", "/v1/devices/\(escaped)"), as: OKResponse.self)
    }

    func forgetMe() async throws {
        _ = try await send(request("DELETE", "/v1/memory"), as: OKResponse.self)
    }

    /// wss://host/v1/ws (http → ws, https → wss).
    var webSocketURL: URL? {
        guard var comps = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) else { return nil }
        comps.scheme = (comps.scheme == "http") ? "ws" : "wss"
        comps.path = (comps.path.hasSuffix("/") ? String(comps.path.dropLast()) : comps.path) + "/v1/ws"
        return comps.url
    }
}
