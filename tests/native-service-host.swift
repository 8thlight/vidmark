import Foundation

// An isolated native parent used to exercise the production pipe protocol.
@main
struct ServiceHost {
    static func main() throws {
        let child = Process()
        child.executableURL = URL(fileURLWithPath: CommandLine.arguments[1])
        let pipe = Pipe()
        child.standardInput = pipe
        var environment = ProcessInfo.processInfo.environment
        let token = UUID().uuidString
        environment["VIDMARK_SESSION_TOKEN"] = token
        child.environment = environment
        child.terminationHandler = { process in
            if process.terminationStatus != 0 { exit(process.terminationStatus) }
        }
        try child.run()
        try pipe.fileHandleForReading.close()
        try pipe.fileHandleForWriting.write(contentsOf: Data("\(token)\n".utf8))
        let command = readLine()
        if command == "stop" { child.terminate() }
        try pipe.fileHandleForWriting.close()
        child.waitUntilExit()
    }
}
