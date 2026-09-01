import AppKit
import WebKit

final class VidmarkAppDelegate: NSObject, NSApplicationDelegate, NSWindowDelegate, WKNavigationDelegate, WKUIDelegate {
    private let appURL = URL(string: "http://localhost:3010/")!
    private var window: NSWindow!
    private var webView: WKWebView!
    private var statusLabel: NSTextField!
    private var progress: NSProgressIndicator!
    private var retryButton: NSButton!
    private var readinessTimer: Timer?
    private var readinessAttempts = 0
    private var serverProcess: Process?
    private var serverLog: FileHandle?
    private var isTerminating = false

    func applicationDidFinishLaunching(_ notification: Notification) {
        buildMenu()
        buildWindow()
        launchServer()
        waitForServer()
        NSApp.activate(ignoringOtherApps: true)
    }

    func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool { true }

    func applicationWillTerminate(_ notification: Notification) {
        isTerminating = true
        readinessTimer?.invalidate()
        stopServer()
    }

    private func buildMenu() {
        let mainMenu = NSMenu()
        let appMenuItem = NSMenuItem()
        mainMenu.addItem(appMenuItem)
        let appMenu = NSMenu()
        appMenu.addItem(withTitle: "About Vidmark", action: #selector(NSApplication.orderFrontStandardAboutPanel(_:)), keyEquivalent: "")
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

        let loadingStack = NSStackView(views: [progress, statusLabel, retryButton])
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
                guard let self, !self.isTerminating, self.webView.isHidden else { return }
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
        readinessAttempts = 0
        readinessTimer?.invalidate()
        readinessTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] timer in
            guard let self else { timer.invalidate(); return }
            var request = URLRequest(url: self.appURL)
            request.timeoutInterval = 0.8
            URLSession.shared.dataTask(with: request) { _, response, _ in
                guard let http = response as? HTTPURLResponse, (200..<500).contains(http.statusCode) else {
                    DispatchQueue.main.async {
                        self.readinessAttempts += 1
                        if self.readinessAttempts >= 120 {
                            timer.invalidate()
                            self.showStartupError("Vidmark did not become ready within 30 seconds. Check ~/Library/Logs/Vidmark/server.log.")
                        }
                    }
                    return
                }
                DispatchQueue.main.async {
                    timer.invalidate()
                    self.statusLabel.stringValue = "Loading workspace…"
                    self.webView.load(URLRequest(url: self.appURL))
                }
            }.resume()
        }
    }

    @objc private func retryStartup() {
        retryButton.isHidden = true
        progress.isHidden = false
        progress.startAnimation(nil)
        statusLabel.stringValue = "Restarting Vidmark…"
        stopServer()
        launchServer()
        waitForServer()
    }

    private func showStartupError(_ message: String) {
        progress.stopAnimation(nil)
        progress.isHidden = true
        statusLabel.stringValue = message
        retryButton.isHidden = false
    }

    private func stopServer() {
        guard let process = serverProcess, process.isRunning else { return }
        process.terminate()
        serverProcess = nil
        try? serverLog?.close()
        serverLog = nil
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        webView.isHidden = false
        progress.superview?.isHidden = true
        window.title = webView.title ?? "Vidmark"
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
}

let application = NSApplication.shared
let delegate = VidmarkAppDelegate()
application.delegate = delegate
application.setActivationPolicy(.regular)
application.run()
