import AppKit
import Sparkle
import UserNotifications
import WebKit

private struct VidmarkDesktopNotification: Decodable {
    let sequence: Int
    let eventId: String
    let kind: String
    let title: String
    let body: String
    let target: String
    let entityId: String
}

private struct VidmarkNotificationFeed: Decodable {
    let installationId: String
    let notifications: [VidmarkDesktopNotification]
    let cursor: Int
    let unreadCount: Int
}

final class VidmarkAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate, UNUserNotificationCenterDelegate {
    private let appURL = URL(string: "http://localhost:3010/")!
    private let notificationsURL = URL(string: "http://127.0.0.1:31417/api/desktop-notifications")!
    private let notificationCenter = UNUserNotificationCenter.current()
    private let notificationCursorKey = "VidmarkDesktopNotificationCursor"
    private let notificationInstallationKey = "VidmarkDesktopNotificationInstallation"
    private let authenticationController = VidmarkAuthenticationController()
    private lazy var updaterController = SPUStandardUpdaterController(startingUpdater: true, updaterDelegate: nil, userDriverDelegate: nil)
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusLabel: NSTextField!
    private var progress: NSProgressIndicator!
    private var retryButton: NSButton!
    private var loadingStack: NSStackView!
    private var readinessTimer: Timer?
    private var notificationTimer: Timer?
    private var readinessAttempts = 0
    private var notificationCursor = 0
    private var notificationInstallationId = ""
    private var notificationsConfigured = false
    private var pendingNotificationTarget: (target: String, entityId: String)?
    private var serverProcess: Process?
    private var serverLog: FileHandle?
    private var claudeExtensionURL: URL?
    private var isTerminating = false
    private let accessSession = VidmarkAccessSession()
    private var isAuthenticated: Bool { accessSession.isAuthenticated }

    func applicationDidFinishLaunching(_ notification: Notification) {
        notificationCursor = UserDefaults.standard.integer(forKey: notificationCursorKey)
        notificationInstallationId = UserDefaults.standard.string(forKey: notificationInstallationKey) ?? ""
        buildMenu()
        buildWindow()
        observeWorkspaceSecurityEvents()
        NSApp.activate(ignoringOtherApps: true)
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.25) { [weak self] in
            self?.beginAuthentication()
        }
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { false }

    func applicationShouldHandleReopen(_ sender: NSApplication, hasVisibleWindows flag: Bool) -> Bool {
        if !flag { window.makeKeyAndOrderFront(nil) }
        if !isAuthenticated { beginAuthentication() }
        return true
    }

    func applicationWillTerminate(_ notification: Notification) {
        isTerminating = true
        accessSession.lock()
        authenticationController.cancel()
        readinessTimer?.invalidate()
        notificationTimer?.invalidate()
        NSWorkspace.shared.notificationCenter.removeObserver(self)
        NSApp.dockTile.badgeLabel = nil
        stopServer()
    }

    private func buildMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Vidmark", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
        let checkForUpdatesItem = NSMenuItem(title: "Check for Updates…", action: #selector(SPUStandardUpdaterController.checkForUpdates(_:)), keyEquivalent: "")
        checkForUpdatesItem.target = updaterController
        appMenu.addItem(checkForUpdatesItem)
        appMenu.addItem(withTitle: "Reveal Claude Desktop Extension…", action: #selector(revealClaudeExtension), keyEquivalent: "")
        appMenu.addItem(withTitle: "Notification Settings…", action: #selector(openNotificationSettings), keyEquivalent: "")
        appMenu.addItem(withTitle: "Security Settings…", action: #selector(openSecuritySettings), keyEquivalent: "")
        appMenu.addItem(withTitle: "Lock Vidmark", action: #selector(lockVidmark), keyEquivalent: "l")
        appMenu.addItem(NSMenuItem.separator())
        appMenu.addItem(withTitle: "Quit Vidmark", action: #selector(NSApplication.terminate(_:)), keyEquivalent: "q")
        appMenuItem.submenu = appMenu

        let editItem = NSMenuItem()
        mainMenu.addItem(editItem)
        let editMenu = NSMenu(title: "Edit")
        editMenu.addItem(withTitle: "Undo", action: Selector(("undo:")), keyEquivalent: "z")
        editMenu.addItem(withTitle: "Redo", action: Selector(("redo:")), keyEquivalent: "Z")
        editMenu.addItem(NSMenuItem.separator())
        editMenu.addItem(withTitle: "Cut", action: #selector(NSText.cut(_:)), keyEquivalent: "x")
        editMenu.addItem(withTitle: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
        editMenu.addItem(withTitle: "Paste", action: #selector(NSText.paste(_:)), keyEquivalent: "v")
        editMenu.addItem(withTitle: "Select All", action: #selector(NSText.selectAll(_:)), keyEquivalent: "a")
        editItem.submenu = editMenu
        NSApp.mainMenu = mainMenu
    }

    private func configureNotifications() {
        guard !notificationsConfigured else { return }
        notificationsConfigured = true
        notificationCenter.delegate = self
        let openAction = UNNotificationAction(identifier: "OPEN_VIDMARK", title: "Open in Vidmark", options: [.foreground])
        let category = UNNotificationCategory(identifier: "VIDMARK_COLLABORATION", actions: [openAction], intentIdentifiers: [], options: [])
        notificationCenter.setNotificationCategories([category])
        notificationCenter.requestAuthorization(options: [.alert, .sound, .badge]) { _, error in
            if let error { NSLog("Vidmark notification permission error: \(error.localizedDescription)") }
        }
    }

    @objc private func openNotificationSettings() {
        guard let url = URL(string: "x-apple.systempreferences:com.apple.Notifications-Settings.extension") else { return }
        NSWorkspace.shared.open(url)
    }

    @objc private func openSecuritySettings() {
        guard isAuthenticated else { beginAuthentication(); return }
        let revision = accessSession.revision
        authenticationController.changeAuthentication { success in
            if success, self.accessSession.acceptsWork(from: revision) {
                let alert = NSAlert()
                alert.messageText = "Vidmark security updated"
                alert.informativeText = "Vidmark will use \(self.authenticationController.modeDescription) the next time it is locked or opened."
                alert.runModal()
            }
        }
    }

    @objc private func lockVidmark() {
        lockApplication()
    }

    private func observeWorkspaceSecurityEvents() {
        let center = NSWorkspace.shared.notificationCenter
        center.addObserver(self, selector: #selector(handleWorkspaceLock(_:)), name: NSWorkspace.sessionDidResignActiveNotification, object: nil)
        center.addObserver(self, selector: #selector(handleWorkspaceLock(_:)), name: NSWorkspace.screensDidSleepNotification, object: nil)
    }

    @objc private func handleWorkspaceLock(_ notification: Notification) {
        lockApplication()
    }

    private func beginAuthentication() {
        guard !isTerminating, let attempt = accessSession.beginAuthentication() else { return }
        showLockedState(message: authenticationController.mode == nil ? "Choose how to protect Vidmark…" : "Vidmark is locked")
        authenticationController.authenticateOrConfigure { [weak self] success in
            guard let self, !self.isTerminating, self.accessSession.revision == attempt else { return }
            if self.accessSession.completeAuthentication(attempt, success: success) { self.unlockAndStart() }
            else { self.showLockedState(message: "Vidmark is locked") }
        }
    }

    private func unlockAndStart() {
        guard isAuthenticated else { return }
        retryButton.isHidden = true
        retryButton.title = "Try Again"
        progress.isHidden = false
        progress.startAnimation(nil)
        statusLabel.stringValue = "Starting Vidmark…"
        launchServer()
        waitForServer()
    }

    private func lockApplication() {
        accessSession.lock()
        authenticationController.cancel()
        readinessTimer?.invalidate()
        readinessTimer = nil
        notificationTimer?.invalidate()
        notificationTimer = nil
        NSApp.dockTile.badgeLabel = nil
        webView.stopLoading()
        webView.load(URLRequest(url: URL(string: "about:blank")!))
        showLockedState(message: "Vidmark is locked")
        stopServer()
    }

    private func showLockedState(message: String) {
        webView.isHidden = true
        loadingStack.isHidden = false
        progress.stopAnimation(nil)
        progress.isHidden = true
        statusLabel.stringValue = message
        retryButton.title = "Unlock Vidmark"
        retryButton.isHidden = false
        window.makeKeyAndOrderFront(nil)
    }

    private func installBundledClaudeExtension() {
        guard let source = Bundle.main.resourceURL?.appendingPathComponent("ClaudeDesktop/Vidmark.mcpb"),
              FileManager.default.fileExists(atPath: source.path) else {
            NSLog("Vidmark Claude Desktop extension is missing from the app bundle.")
            return
        }
        let directory = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Application Support/Vidmark/Claude Desktop", isDirectory: true)
        let destination = directory.appendingPathComponent("Vidmark.mcpb")
        do {
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            if FileManager.default.fileExists(atPath: destination.path),
               FileManager.default.contentsEqual(atPath: source.path, andPath: destination.path) {
                claudeExtensionURL = destination
                return
            }
            let temporary = directory.appendingPathComponent("Vidmark.mcpb.next")
            try? FileManager.default.removeItem(at: temporary)
            try FileManager.default.copyItem(at: source, to: temporary)
            if FileManager.default.fileExists(atPath: destination.path) { try FileManager.default.removeItem(at: destination) }
            try FileManager.default.moveItem(at: temporary, to: destination)
            claudeExtensionURL = destination
        } catch {
            NSLog("Vidmark could not copy the Claude Desktop extension: \(error.localizedDescription)")
        }
    }

    @objc private func revealClaudeExtension() {
        if claudeExtensionURL == nil { installBundledClaudeExtension() }
        guard let claudeExtensionURL else {
            let alert = NSAlert()
            alert.messageText = "Claude Desktop extension unavailable"
            alert.informativeText = "Vidmark could not copy its bundled .mcpb file. Reinstall Vidmark and try again."
            alert.runModal()
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([claudeExtensionURL])
    }

    private func buildWindow() {
        let configuration = WKWebViewConfiguration()
        configuration.mediaTypesRequiringUserActionForPlayback = []
        webView = WKWebView(frame: .zero, configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        webView.translatesAutoresizingMaskIntoConstraints = false
        webView.isHidden = true

        statusLabel = NSTextField(labelWithString: "Starting Vidmark…")
        statusLabel.font = .systemFont(ofSize: 15, weight: .medium)
        statusLabel.textColor = .secondaryLabelColor
        statusLabel.alignment = .center

        progress = NSProgressIndicator()
        progress.style = .spinning
        progress.controlSize = .regular
        progress.startAnimation(nil)

        retryButton = NSButton(title: "Try Again", target: self, action: #selector(retryStartup))
        retryButton.bezelStyle = .rounded
        retryButton.isHidden = true

        loadingStack = NSStackView(views: [progress, statusLabel, retryButton])
        loadingStack.orientation = .vertical
        loadingStack.alignment = .centerX
        loadingStack.spacing = 12
        loadingStack.translatesAutoresizingMaskIntoConstraints = false

        let content = NSView()
        content.wantsLayer = true
        content.layer?.backgroundColor = NSColor.windowBackgroundColor.cgColor
        content.addSubview(webView)
        content.addSubview(loadingStack)
        NSLayoutConstraint.activate([
            webView.leadingAnchor.constraint(equalTo: content.leadingAnchor),
            webView.trailingAnchor.constraint(equalTo: content.trailingAnchor),
            webView.topAnchor.constraint(equalTo: content.topAnchor),
            webView.bottomAnchor.constraint(equalTo: content.bottomAnchor),
            loadingStack.centerXAnchor.constraint(equalTo: content.centerXAnchor),
            loadingStack.centerYAnchor.constraint(equalTo: content.centerYAnchor),
        ])

        window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1440, height: 900),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false
        )
        window.title = "Vidmark"
        window.minSize = NSSize(width: 960, height: 640)
        window.contentView = content
        window.delegate = self
        window.setFrameAutosaveName("VidmarkMainWindow")
        if !window.setFrameUsingName("VidmarkMainWindow") { window.center() }
        window.makeKeyAndOrderFront(nil)
    }

    private func launchServer() {
        guard isAuthenticated, !isTerminating else { return }
        guard let executable = Bundle.main.executableURL?.deletingLastPathComponent().appendingPathComponent("VidmarkServer") else {
            showStartupError("The packaged Bun server is missing.")
            return
        }

        let logs = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/Logs/Vidmark", isDirectory: true)
        try? FileManager.default.createDirectory(at: logs, withIntermediateDirectories: true)
        let logURL = logs.appendingPathComponent("server.log")
        if !FileManager.default.fileExists(atPath: logURL.path) { FileManager.default.createFile(atPath: logURL.path, contents: nil) }
        serverLog = try? FileHandle(forWritingTo: logURL)
        _ = try? serverLog?.seekToEnd()

        let process = Process()
        process.executableURL = executable
        process.currentDirectoryURL = Bundle.main.resourceURL
        var environment = ProcessInfo.processInfo.environment
        environment["VIDMARK_NATIVE_SHELL"] = "1"
        process.environment = environment
        process.standardOutput = serverLog
        process.standardError = serverLog
        process.terminationHandler = { [weak self] process in
            DispatchQueue.main.async {
                guard let self, !self.isTerminating, self.isAuthenticated, self.serverProcess === process else { return }
                self.showStartupError("The local server stopped unexpectedly (code \(process.terminationStatus)).")
            }
        }
        do {
            try process.run()
            serverProcess = process
        } catch {
            showStartupError("The Bun server could not start: \(error.localizedDescription)")
        }
    }

    private func waitForServer() {
        let revision = accessSession.revision
        readinessAttempts = 0
        readinessTimer?.invalidate()
        readinessTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] timer in
            guard let self, self.accessSession.acceptsWork(from: revision) else { timer.invalidate(); return }
            var request = URLRequest(url: self.appURL)
            request.timeoutInterval = 0.8
            URLSession.shared.dataTask(with: request) { _, response, _ in
                guard let http = response as? HTTPURLResponse, (200..<500).contains(http.statusCode) else {
                    DispatchQueue.main.async {
                        guard timer.isValid, self.accessSession.acceptsWork(from: revision) else { return }
                        self.readinessAttempts += 1
                        if self.readinessAttempts >= 120 {
                            timer.invalidate()
                            self.showStartupError("Vidmark did not become ready within 30 seconds. Check ~/Library/Logs/Vidmark/server.log.")
                        }
                    }
                    return
                }
                DispatchQueue.main.async {
                    guard timer.isValid, self.accessSession.acceptsWork(from: revision) else { return }
                    timer.invalidate()
                    self.statusLabel.stringValue = "Loading workspace…"
                    self.webView.load(URLRequest(url: self.appURL))
                    self.startNotificationPolling()
                }
            }.resume()
        }
    }

    @objc private func retryStartup() {
        if !isAuthenticated {
            beginAuthentication()
            return
        }
        retryButton.isHidden = true
        retryButton.title = "Try Again"
        progress.isHidden = false
        progress.startAnimation(nil)
        statusLabel.stringValue = "Restarting Vidmark…"
        stopServer()
        launchServer()
        waitForServer()
    }

    private func showStartupError(_ message: String) {
        guard isAuthenticated, !isTerminating else { return }
        webView.isHidden = true
        loadingStack.isHidden = false
        progress.stopAnimation(nil)
        progress.isHidden = true
        statusLabel.stringValue = message
        retryButton.isHidden = false
    }

    private func startNotificationPolling() {
        guard isAuthenticated, notificationTimer == nil else { return }
        pollDesktopNotifications()
        let timer = Timer(timeInterval: 3, repeats: true) { [weak self] _ in self?.pollDesktopNotifications() }
        RunLoop.main.add(timer, forMode: .common)
        notificationTimer = timer
    }

    private func pollDesktopNotifications() {
        guard isAuthenticated else { return }
        let revision = accessSession.revision
        var components = URLComponents(url: notificationsURL, resolvingAgainstBaseURL: false)!
        components.queryItems = [URLQueryItem(name: "after", value: String(notificationCursor)), URLQueryItem(name: "limit", value: "50")]
        guard let url = components.url else { return }
        let requestedCursor = notificationCursor
        var request = URLRequest(url: url)
        request.timeoutInterval = 2
        URLSession.shared.dataTask(with: request) { [weak self] data, response, _ in
            guard let self, let data, let http = response as? HTTPURLResponse, http.statusCode == 200,
                  let feed = try? JSONDecoder().decode(VidmarkNotificationFeed.self, from: data) else { return }
            DispatchQueue.main.async {
                guard self.accessSession.acceptsWork(from: revision) else { return }
                self.handleNotificationFeed(feed, requestedCursor: requestedCursor)
            }
        }.resume()
    }

    private func handleNotificationFeed(_ feed: VidmarkNotificationFeed, requestedCursor: Int) {
        if notificationInstallationId != feed.installationId {
            notificationInstallationId = feed.installationId
            notificationCursor = 0
            UserDefaults.standard.set(feed.installationId, forKey: notificationInstallationKey)
            UserDefaults.standard.set(0, forKey: notificationCursorKey)
            if requestedCursor > 0 { pollDesktopNotifications(); return }
        }

        let shouldShowBanner = !(NSApp.isActive && window.isKeyWindow)
        for item in feed.notifications {
            if shouldShowBanner { scheduleDesktopNotification(item) }
            notificationCursor = max(notificationCursor, item.sequence)
        }
        notificationCursor = max(notificationCursor, feed.cursor)
        UserDefaults.standard.set(notificationCursor, forKey: notificationCursorKey)
        NSApp.dockTile.badgeLabel = feed.unreadCount > 0 ? String(feed.unreadCount) : nil
    }

    private func scheduleDesktopNotification(_ item: VidmarkDesktopNotification) {
        let content = UNMutableNotificationContent()
        content.title = item.title
        content.body = item.body
        content.sound = .default
        content.categoryIdentifier = "VIDMARK_COLLABORATION"
        content.threadIdentifier = item.kind
        content.userInfo = ["target": item.target, "entityId": item.entityId]
        notificationCenter.add(UNNotificationRequest(identifier: item.eventId, content: content, trigger: nil))
    }

    private func openNotificationTarget(target: String, entityId: String) {
        NSApp.activate(ignoringOtherApps: true)
        window.makeKeyAndOrderFront(nil)
        pendingNotificationTarget = (target, entityId)
        if !isAuthenticated { beginAuthentication(); return }
        dispatchPendingNotificationTarget()
    }

    private func dispatchPendingNotificationTarget() {
        guard isAuthenticated, !webView.isHidden, let pendingNotificationTarget, !webView.isLoading, webView.url?.scheme == "http" else { return }
        let payload: [String: String] = ["target": pendingNotificationTarget.target, "entityId": pendingNotificationTarget.entityId]
        guard let data = try? JSONSerialization.data(withJSONObject: payload), let json = String(data: data, encoding: .utf8) else { return }
        self.pendingNotificationTarget = nil
        webView.evaluateJavaScript("window.dispatchEvent(new CustomEvent('vidmark:native-notification', { detail: \(json) }));")
    }

    private func stopServer() {
        if let process = serverProcess, process.isRunning {
            process.terminationHandler = nil
            process.terminate()
            // A new unlock must not reuse the previous process's still-open ports.
            let deadline = Date().addingTimeInterval(2)
            while process.isRunning && Date() < deadline { Thread.sleep(forTimeInterval: 0.01) }
            if process.isRunning { kill(process.processIdentifier, SIGKILL) }
            process.waitUntilExit()
        }
        serverProcess = nil
        try? serverLog?.close()
        serverLog = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard isAuthenticated, webView.url?.scheme != "about" else { return }
        installBundledClaudeExtension()
        webView.isHidden = false
        progress.superview?.isHidden = true
        window.title = webView.title ?? "Vidmark"
        configureNotifications()
        if pendingNotificationTarget != nil {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.5) { [weak self] in self?.dispatchPendingNotificationTarget() }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showStartupError("The workspace could not load: \(error.localizedDescription)")
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        guard let url = navigationAction.request.url else { decisionHandler(.cancel); return }
        let isLocal = url.host == "localhost" || url.host == "127.0.0.1"
        if navigationAction.navigationType == .linkActivated && !isLocal {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
            return
        }
        decisionHandler(.allow)
    }

    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? {
        if navigationAction.targetFrame == nil, let url = navigationAction.request.url { NSWorkspace.shared.open(url) }
        return nil
    }

    @available(macOS 12.0, *)
    func webView(_ webView: WKWebView, requestMediaCapturePermissionFor origin: WKSecurityOrigin, initiatedByFrame frame: WKFrameInfo, type: WKMediaCaptureType, decisionHandler: @escaping (WKPermissionDecision) -> Void) {
        decisionHandler(type == .microphone ? .grant : .prompt)
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification, withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
        completionHandler(NSApp.isActive && window.isKeyWindow ? [] : [.banner, .list, .sound])
    }

    func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse, withCompletionHandler completionHandler: @escaping () -> Void) {
        let info = response.notification.request.content.userInfo
        let target = info["target"] as? String ?? "inbox"
        let entityId = info["entityId"] as? String ?? ""
        DispatchQueue.main.async { [weak self] in self?.openNotificationTarget(target: target, entityId: entityId) }
        completionHandler()
    }
}

@main
struct VidmarkApplication {
    static func main() {
        let application = NSApplication.shared
        let delegate = VidmarkAppDelegate()
        application.delegate = delegate
        application.setActivationPolicy(.regular)
        application.run()
    }
}
