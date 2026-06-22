// PracticeSync — Apple Intelligence helper.
//
// A tiny command-line bridge to Apple's on-device Foundation Models (macOS 26+,
// Apple Silicon). Electron/Node can't call FoundationModels directly, so the app
// shells out to this binary: it reads {"system","text"} as JSON on stdin and
// prints {"providers":[{"name","mainDoctor","codes"}]} as JSON on stdout.
// Guided generation (@Generable) guarantees the shape — the model can't return
// free-form prose. Any failure exits non-zero so the app falls back to the next
// engine (local Gemma / built-in parser).
//
// Build: build/build-apple-helper.sh  →  build/bin/apple-intelligence

import Foundation
import FoundationModels

// The structure the on-device model is constrained to produce.
@Generable
struct ProviderOut {
    @Guide(description: "The treating (subordinate) doctor's name only — not the supervising doctor")
    var name: String
    @Guide(description: "The EXACT name of the main/supervising doctor this person works under, or an empty string if none is stated")
    var mainDoctor: String
    @Guide(description: "This doctor's billing codes, normalized like '97112 x2, 97530 x2 (59)'. Units as a digit after x; modifiers in parentheses.")
    var codes: String
}

@Generable
struct RosterOut {
    @Guide(description: "One entry per treating doctor mentioned in the text")
    var providers: [ProviderOut]
}

// stdin / stdout JSON shapes.
struct InputPayload: Codable { var system: String; var text: String }
struct ProviderJSON: Codable { var name: String; var mainDoctor: String; var codes: String }
struct OutputJSON: Codable { var providers: [ProviderJSON] }

func die(_ message: String) -> Never {
    FileHandle.standardError.write(Data((message + "\n").utf8))
    exit(2)
}

@main
struct AppleHelper {
    static func main() async {
        let input = FileHandle.standardInput.readDataToEndOfFile()
        guard let payload = try? JSONDecoder().decode(InputPayload.self, from: input) else {
            die("bad input: expected JSON {system, text} on stdin")
        }

        let model = SystemLanguageModel.default
        switch model.availability {
        case .available:
            break
        case .unavailable(let reason):
            die("Apple Intelligence unavailable: \(reason)")
        @unknown default:
            die("Apple Intelligence unavailable")
        }

        let session = LanguageModelSession(instructions: payload.system)
        do {
            let response = try await session.respond(to: payload.text, generating: RosterOut.self)
            let out = OutputJSON(providers: response.content.providers.map {
                ProviderJSON(name: $0.name, mainDoctor: $0.mainDoctor, codes: $0.codes)
            })
            FileHandle.standardOutput.write(try JSONEncoder().encode(out))
        } catch {
            die("generation failed: \(error)")
        }
    }
}
