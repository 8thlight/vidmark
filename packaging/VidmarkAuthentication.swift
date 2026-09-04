import AppKit
import CommonCrypto
import LocalAuthentication
import Security

enum VidmarkAuthenticationMode: String {
    case system
    case pin
}

final class VidmarkAuthenticationController {
    private let modeKey = "VidmarkAuthenticationMode"
    private let failedAttemptsKey = "VidmarkPINFailedAttempts"
    private let lockoutUntilKey = "VidmarkPINLockoutUntil"
    private let pinSaltKey = "VidmarkPINSalt"
    private let pinVerifierKey = "VidmarkPINVerifier"
    private let pinDerivationRounds: UInt32 = 250_000
    private var defaults: UserDefaults { .standard }

    var mode: VidmarkAuthenticationMode? {
        guard let value = defaults.string(forKey: modeKey) else { return nil }
        return VidmarkAuthenticationMode(rawValue: value)
    }

    var modeDescription: String {
        switch mode {
        case .system: return "Mac authentication"
        case .pin: return "Vidmark PIN"
        case nil: return "Not configured"
        }
    }

    func authenticateOrConfigure(completion: @escaping (Bool) -> Void) {
        guard let mode else {
            configureInitialAuthentication(completion: completion)
            return
        }
        authenticate(using: mode, completion: completion)
    }

    func changeAuthentication(completion: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Vidmark security"
        alert.informativeText = "Current method: \(modeDescription). Choose how Vidmark should verify you when it opens."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Use Mac Authentication")
        alert.addButton(withTitle: "Use a PIN")
        alert.addButton(withTitle: "Cancel")

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            authenticateWithMac(reason: "Confirm your identity to use Mac authentication for Vidmark") { [weak self] success in
                guard let self, success else { completion(false); return }
                self.defaults.set(VidmarkAuthenticationMode.system.rawValue, forKey: self.modeKey)
                self.deletePIN()
                self.resetPINFailures()
                completion(true)
            }
        case .alertSecondButtonReturn:
            completion(configurePIN())
        default:
            completion(false)
        }
    }

    private func configureInitialAuthentication(completion: @escaping (Bool) -> Void) {
        let alert = NSAlert()
        alert.messageText = "Protect Vidmark"
        alert.informativeText = "Require authentication before Vidmark opens your courses or starts its local services. Mac authentication uses Touch ID or your Mac login password."
        alert.alertStyle = .informational
        alert.addButton(withTitle: "Use Mac Authentication")
        alert.addButton(withTitle: "Use a PIN")
        alert.addButton(withTitle: "Quit")

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            authenticateWithMac(reason: "Set up Mac authentication for Vidmark") { [weak self] success in
                guard let self, success else { completion(false); return }
                self.defaults.set(VidmarkAuthenticationMode.system.rawValue, forKey: self.modeKey)
                completion(true)
            }
        case .alertSecondButtonReturn:
            completion(configurePIN())
        default:
            NSApp.terminate(nil)
            completion(false)
        }
    }

    private func authenticate(using mode: VidmarkAuthenticationMode, completion: @escaping (Bool) -> Void) {
        switch mode {
        case .system:
            authenticateWithMac(reason: "Unlock Vidmark", completion: completion)
        case .pin:
            authenticateWithPIN(completion: completion)
        }
    }

    private func authenticateWithMac(reason: String, completion: @escaping (Bool) -> Void) {
        let context = LAContext()
        context.localizedCancelTitle = "Cancel"
        var policyError: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &policyError) else {
            showError(title: "Mac authentication is unavailable", message: policyError?.localizedDescription ?? "Set a login password or Touch ID in System Settings, then try again.")
            completion(false)
            return
        }
        context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason) { success, error in
            DispatchQueue.main.async {
                if !success, let error = error as? LAError, error.code != .userCancel && error.code != .appCancel && error.code != .systemCancel {
                    self.showError(title: "Could not unlock Vidmark", message: error.localizedDescription)
                }
                completion(success)
            }
        }
    }

    private func configurePIN() -> Bool {
        while true {
            let first = NSSecureTextField(string: "")
            let confirmation = NSSecureTextField(string: "")
            first.placeholderString = "6-digit PIN"
            confirmation.placeholderString = "Confirm PIN"
            first.alignment = .center
            confirmation.alignment = .center

            let fields = NSStackView(views: [first, confirmation])
            fields.orientation = .vertical
            fields.spacing = 8
            fields.edgeInsets = NSEdgeInsets(top: 4, left: 0, bottom: 4, right: 0)
            fields.frame = NSRect(x: 0, y: 0, width: 280, height: 58)

            let alert = NSAlert()
            alert.messageText = "Create a Vidmark PIN"
            alert.informativeText = "Enter the same six digits twice. Vidmark stores only a salted, one-way verifier on this Mac—not the PIN itself."
            alert.alertStyle = .informational
            alert.accessoryView = fields
            alert.addButton(withTitle: "Save PIN")
            alert.addButton(withTitle: "Cancel")
            alert.window.initialFirstResponder = first

            guard alert.runModal() == .alertFirstButtonReturn else { return false }
            let pin = first.stringValue
            guard isValidPIN(pin) else {
                showError(title: "Use six digits", message: "A Vidmark PIN must contain exactly six numeric digits.")
                continue
            }
            guard pin == confirmation.stringValue else {
                showError(title: "PINs do not match", message: "Re-enter and confirm the same PIN.")
                continue
            }
            guard savePIN(pin) else {
                showError(title: "PIN could not be saved", message: "Vidmark could not create a secure local PIN verifier.")
                return false
            }
            defaults.set(VidmarkAuthenticationMode.pin.rawValue, forKey: modeKey)
            resetPINFailures()
            return true
        }
    }

    private func authenticateWithPIN(completion: @escaping (Bool) -> Void) {
        let lockoutUntil = defaults.double(forKey: lockoutUntilKey)
        if lockoutUntil > Date().timeIntervalSince1970 {
            let seconds = Int(ceil(lockoutUntil - Date().timeIntervalSince1970))
            showError(title: "Try again shortly", message: "Too many incorrect attempts. Vidmark is locked for another \(seconds) seconds.")
            completion(false)
            return
        }

        guard let savedSalt = defaults.data(forKey: pinSaltKey),
              let savedVerifier = defaults.data(forKey: pinVerifierKey) else {
            showError(title: "PIN unavailable", message: "The local PIN verifier is missing. Use Mac authentication to recover access.")
            authenticateWithMac(reason: "Recover access to Vidmark") { [weak self] success in
                if let self, success { self.defaults.removeObject(forKey: self.modeKey) }
                completion(success)
            }
            return
        }

        let field = NSSecureTextField(string: "")
        field.placeholderString = "6-digit PIN"
        field.alignment = .center
        field.frame = NSRect(x: 0, y: 0, width: 240, height: 24)

        let alert = NSAlert()
        alert.messageText = "Unlock Vidmark"
        alert.informativeText = "Enter your six-digit Vidmark PIN."
        alert.alertStyle = .informational
        alert.accessoryView = field
        alert.addButton(withTitle: "Unlock")
        alert.addButton(withTitle: "Use Mac Authentication")
        alert.addButton(withTitle: "Cancel")
        alert.window.initialFirstResponder = field

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            if let candidate = derivePINVerifier(pin: field.stringValue, salt: savedSalt),
               securelyMatches(candidate, savedVerifier) {
                resetPINFailures()
                completion(true)
            } else {
                recordPINFailure()
                showError(title: "Incorrect PIN", message: "The PIN you entered is not correct.")
                completion(false)
            }
        case .alertSecondButtonReturn:
            authenticateWithMac(reason: "Unlock Vidmark", completion: completion)
        default:
            completion(false)
        }
    }

    private func savePIN(_ pin: String) -> Bool {
        let saltLength = 32
        var salt = Data(count: saltLength)
        let status = salt.withUnsafeMutableBytes { bytes in
            SecRandomCopyBytes(kSecRandomDefault, saltLength, bytes.baseAddress!)
        }
        guard status == errSecSuccess,
              let verifier = derivePINVerifier(pin: pin, salt: salt) else { return false }
        defaults.set(salt, forKey: pinSaltKey)
        defaults.set(verifier, forKey: pinVerifierKey)
        return true
    }

    private func deletePIN() {
        defaults.removeObject(forKey: pinSaltKey)
        defaults.removeObject(forKey: pinVerifierKey)
    }

    private func isValidPIN(_ pin: String) -> Bool {
        let bytes = Array(pin.utf8)
        return bytes.count == 6 && bytes.allSatisfy { (48...57).contains($0) }
    }

    private func derivePINVerifier(pin: String, salt: Data) -> Data? {
        let derivedLength = Int(CC_SHA256_DIGEST_LENGTH)
        var derived = Data(count: derivedLength)
        let status = salt.withUnsafeBytes { saltBytes in
            derived.withUnsafeMutableBytes { derivedBytes in
                pin.withCString { password in
                    CCKeyDerivationPBKDF(
                        CCPBKDFAlgorithm(kCCPBKDF2),
                        password,
                        pin.utf8.count,
                        saltBytes.bindMemory(to: UInt8.self).baseAddress,
                        salt.count,
                        CCPseudoRandomAlgorithm(kCCPRFHmacAlgSHA256),
                        pinDerivationRounds,
                        derivedBytes.bindMemory(to: UInt8.self).baseAddress,
                        derivedLength
                    )
                }
            }
        }
        return status == kCCSuccess ? derived : nil
    }

    private func securelyMatches(_ candidate: Data, _ saved: Data) -> Bool {
        let left = Array(candidate)
        let right = Array(saved)
        guard left.count == right.count else { return false }
        var difference: UInt8 = 0
        for index in left.indices { difference |= left[index] ^ right[index] }
        return difference == 0
    }

    private func recordPINFailure() {
        let failures = defaults.integer(forKey: failedAttemptsKey) + 1
        defaults.set(failures, forKey: failedAttemptsKey)
        if failures >= 5 {
            defaults.set(Date().addingTimeInterval(30).timeIntervalSince1970, forKey: lockoutUntilKey)
            defaults.set(0, forKey: failedAttemptsKey)
        }
    }

    private func resetPINFailures() {
        defaults.removeObject(forKey: failedAttemptsKey)
        defaults.removeObject(forKey: lockoutUntilKey)
    }

    private func showError(title: String, message: String) {
        let alert = NSAlert()
        alert.messageText = title
        alert.informativeText = message
        alert.alertStyle = .warning
        alert.runModal()
    }
}
