import Foundation

// Every lock invalidates both pending authentication and work from the old session.
final class VidmarkAccessSession {
    private(set) var revision = UUID()
    private(set) var isAuthenticated = false
    private(set) var isAuthenticating = false

    func beginAuthentication() -> UUID? {
        guard !isAuthenticated, !isAuthenticating else { return nil }
        isAuthenticating = true
        return revision
    }

    @discardableResult
    func completeAuthentication(_ attempt: UUID, success: Bool) -> Bool {
        guard revision == attempt, isAuthenticating else { return false }
        isAuthenticating = false
        isAuthenticated = success
        return success
    }

    func acceptsWork(from revision: UUID) -> Bool {
        isAuthenticated && self.revision == revision
    }

    func lock() {
        revision = UUID()
        isAuthenticated = false
        isAuthenticating = false
    }
}
