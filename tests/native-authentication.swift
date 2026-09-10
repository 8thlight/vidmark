import AppKit
import Foundation

@main
struct NativeAuthenticationTests {
    static func main() {
        let session = VidmarkAccessSession()
        precondition(!session.isAuthenticated)
        let cancelled = session.beginAuthentication()!
        precondition(session.beginAuthentication() == nil, "Concurrent prompts must be rejected")
        session.lock()
        precondition(!session.completeAuthentication(cancelled, success: true), "Late authentication must not unlock")
        let current = session.beginAuthentication()!
        precondition(!session.completeAuthentication(cancelled, success: true))
        precondition(session.isAuthenticating, "An old callback must not cancel the new prompt")
        precondition(session.completeAuthentication(current, success: true))
        precondition(session.acceptsWork(from: current))
        session.lock()
        precondition(!session.acceptsWork(from: current), "Lock must reject in-flight network responses")
        let next = session.beginAuthentication()!
        precondition(session.completeAuthentication(next, success: true))
        precondition(!session.acceptsWork(from: current), "Reopening must not revive stale work")
        session.lock()
        let failed = session.beginAuthentication()!
        precondition(!session.completeAuthentication(failed, success: false))
        precondition(!session.isAuthenticated && !session.isAuthenticating)

        let domain = "local.vidmark.tests.\(UUID().uuidString)"
        let defaults = UserDefaults(suiteName: domain)!
        defer { defaults.removePersistentDomain(forName: domain) }
        let controller = VidmarkAuthenticationController(defaults: defaults)
        precondition(controller.mode == nil)
        defaults.set(Data(repeating: 1, count: 32), forKey: "VidmarkPINSalt")
        precondition(controller.mode == .pin, "Partial PIN material must not permit first-run setup")
        defaults.set("invalid", forKey: "VidmarkAuthenticationMode")
        precondition(controller.mode == .pin)
        defaults.set("wrong-type", forKey: "VidmarkPINSalt")
        precondition(controller.mode == .pin, "Malformed PIN material must require recovery")
        defaults.set("system", forKey: "VidmarkAuthenticationMode")
        precondition(controller.mode == .system)
        print("Native authentication regression checks passed: stale results, lock/reopen, failed authentication, corrupt preferences.")
    }
}
