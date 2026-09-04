import AVFoundation
import Foundation
import Speech

private struct HealthResponse: Encodable {
    let ok: Bool
    let available: Bool
    let engine: String
    let mode: String
    let reason: String?
}

private struct TranscriptResponse: Encodable {
    let transcript: String
    let engine: String
    let mode: String
}

private enum TranscriberFailure: LocalizedError {
    case invalidArguments
    case missingAudioFile
    case unsupportedLocale
    case unavailable(String)
    case emptyTranscript

    var errorDescription: String? {
        switch self {
        case .invalidArguments:
            return "Usage: VidmarkTranscriber <audio-file> [locale], or VidmarkTranscriber --health [locale]."
        case .missingAudioFile:
            return "The recorded audio file could not be found."
        case .unsupportedLocale:
            return "Apple on-device speech recognition does not support the selected language on this Mac."
        case .unavailable(let reason):
            return reason
        case .emptyTranscript:
            return "Apple on-device speech recognition did not detect any words."
        }
    }
}

@main
private enum VidmarkTranscriber {
    private static let engine = "Apple Speech"
    private static let mode = "on-device-only"

    static func main() async {
        do {
            let arguments = Array(CommandLine.arguments.dropFirst())
            if arguments.first == "--health" {
                let locale = arguments.count > 1 ? arguments[1] : "en_US"
                try write(await health(localeIdentifier: locale))
                return
            }

            guard let path = arguments.first else { throw TranscriberFailure.invalidArguments }
            let locale = arguments.count > 1 ? arguments[1] : "en_US"
            guard FileManager.default.fileExists(atPath: path) else { throw TranscriberFailure.missingAudioFile }
            let transcript = try await transcribe(fileURL: URL(fileURLWithPath: path), localeIdentifier: locale)
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !transcript.isEmpty else { throw TranscriberFailure.emptyTranscript }
            try write(TranscriptResponse(transcript: transcript, engine: engine, mode: mode))
        } catch {
            let message = error.localizedDescription
            FileHandle.standardError.write(Data((message + "\n").utf8))
            Foundation.exit(EXIT_FAILURE)
        }
    }

    private static func write<T: Encodable>(_ value: T) throws {
        let data = try JSONEncoder().encode(value)
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
    }

    private static func health(localeIdentifier: String) async -> HealthResponse {
        let locale = Locale(identifier: localeIdentifier)
        if #available(macOS 26.0, *), SpeechTranscriber.isAvailable {
            let supported = await SpeechTranscriber.supportedLocale(equivalentTo: locale) != nil
            return HealthResponse(ok: true, available: supported, engine: engine, mode: mode, reason: supported ? nil : "The selected language is not available for Apple on-device transcription.")
        }

        guard let recognizer = SFSpeechRecognizer(locale: locale) else {
            return HealthResponse(ok: true, available: false, engine: engine, mode: mode, reason: "The selected language is not supported by Apple Speech.")
        }
        let available = recognizer.supportsOnDeviceRecognition
        return HealthResponse(ok: true, available: available, engine: engine, mode: mode, reason: available ? nil : "This Mac does not provide on-device speech recognition for the selected language.")
    }

    private static func transcribe(fileURL: URL, localeIdentifier: String) async throws -> String {
        if #available(macOS 26.0, *), SpeechTranscriber.isAvailable {
            do {
                return try await transcribeWithSpeechAnalyzer(fileURL: fileURL, localeIdentifier: localeIdentifier)
            } catch {
                // Older Macs can still use SFSpeechRecognizer, but it is always forced on-device below.
            }
        }
        return try await transcribeWithLegacySpeech(fileURL: fileURL, localeIdentifier: localeIdentifier)
    }

    @available(macOS 26.0, *)
    private static func transcribeWithSpeechAnalyzer(fileURL: URL, localeIdentifier: String) async throws -> String {
        let requestedLocale = Locale(identifier: localeIdentifier)
        guard let locale = await SpeechTranscriber.supportedLocale(equivalentTo: requestedLocale) else {
            throw TranscriberFailure.unsupportedLocale
        }

        let transcriber = SpeechTranscriber(locale: locale, preset: .transcription)
        let assetStatus = await AssetInventory.status(forModules: [transcriber])
        guard assetStatus != .unsupported else { throw TranscriberFailure.unsupportedLocale }
        if assetStatus != .installed {
            guard let request = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) else {
                throw TranscriberFailure.unavailable("Apple's on-device speech model is not installed for the selected language.")
            }
            try await request.downloadAndInstall()
        }

        let analyzer = SpeechAnalyzer(modules: [transcriber])
        let resultTask = Task<String, Error> {
            var transcript = ""
            for try await result in transcriber.results {
                transcript += String(result.text.characters)
            }
            return transcript
        }
        let audioFile = try AVAudioFile(forReading: fileURL)
        do {
            if let lastSample = try await analyzer.analyzeSequence(from: audioFile) {
                try await analyzer.finalizeAndFinish(through: lastSample)
            } else {
                await analyzer.cancelAndFinishNow()
            }
            return try await resultTask.value
        } catch {
            await analyzer.cancelAndFinishNow()
            resultTask.cancel()
            throw error
        }
    }

    private static func transcribeWithLegacySpeech(fileURL: URL, localeIdentifier: String) async throws -> String {
        let authorization = await withCheckedContinuation { continuation in
            SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
        }
        guard authorization == .authorized else {
            throw TranscriberFailure.unavailable("Speech Recognition permission is required for Apple on-device transcription. The recording can still be saved without a transcript.")
        }
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: localeIdentifier)), recognizer.supportsOnDeviceRecognition else {
            throw TranscriberFailure.unavailable("Apple on-device speech recognition is unavailable for the selected language. The recording can still be saved without a transcript.")
        }

        let request = SFSpeechURLRecognitionRequest(url: fileURL)
        request.shouldReportPartialResults = false
        request.requiresOnDeviceRecognition = true
        return try await withCheckedThrowingContinuation { continuation in
            var resumed = false
            _ = recognizer.recognitionTask(with: request) { result, error in
                guard !resumed else { return }
                if let error {
                    resumed = true
                    continuation.resume(throwing: error)
                } else if let result, result.isFinal {
                    resumed = true
                    continuation.resume(returning: result.bestTranscription.formattedString)
                }
            }
        }
    }
}
