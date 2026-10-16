import Foundation
import PixieCore

/// Backs the "Reply suggestions" settings section (PROTOCOL.md §5 REST endpoints).
@MainActor
final class ReplyRulesModel: ObservableObject {
    @Published private(set) var rules: [ReplyRule] = []
    @Published private(set) var loading = false
    @Published private(set) var loaded = false
    @Published var error: String?
    @Published var status: String?

    private let api: @MainActor () -> BrainAPI?

    init(api: @escaping @MainActor () -> BrainAPI?) {
        self.api = api
    }

    func refresh() {
        guard let api = api() else {
            error = BrainAPIError.notSignedIn.errorDescription
            return
        }
        loading = true
        error = nil
        Task { @MainActor in
            do {
                rules = try await api.replyRules()
                loaded = true
            } catch {
                self.error = ReplyRulesModel.message(for: error)
            }
            loading = false
        }
    }

    func delete(_ rule: ReplyRule) {
        guard let api = api() else {
            error = BrainAPIError.notSignedIn.errorDescription
            return
        }
        error = nil
        status = nil
        Task { @MainActor in
            do {
                try await api.deleteReplyRule(id: rule.id)
            } catch BrainAPIError.server(let httpStatus, _, _) where httpStatus == 404 {
                // Already gone (expired or removed elsewhere); the refresh below drops it.
            } catch {
                self.error = ReplyRulesModel.message(for: error)
            }
            refresh()
        }
    }

    func resetLearning() {
        guard let api = api() else {
            error = BrainAPIError.notSignedIn.errorDescription
            return
        }
        error = nil
        status = nil
        Task { @MainActor in
            do {
                try await api.resetReplyLearning()
                status = "Reply learning reset. Your rules are kept."
            } catch {
                self.error = ReplyRulesModel.message(for: error)
            }
        }
    }

    private static func message(for error: Error) -> String {
        (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
    }
}
