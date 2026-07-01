import Foundation

// The project file surface — directory listing, file read/write, command running, asset images.
// These map to the `localApi.ts` dispatch arms added for the native sidecar (Phase 0): listDir /
// readFile / writeFile / listProjectFiles / runCommand / killCommand / assetImage. All paths are
// project-confined by the brain (`resolveInsideRoot`).

struct DirEntry: Codable, Identifiable, Hashable {
    var name: String
    var path: String          // absolute
    var kind: String          // "file" | "dir" | "other"
    var id: String { path }
    var isDir: Bool { kind == "dir" }
}
struct ListDirResult: Codable { var path: String; var entries: [DirEntry] }
struct ReadFileResult: Codable { var path: String; var text: String; var bytes: Int; var truncated: Bool }
struct WriteFileResult: Codable { var path: String; var bytes: Int; var mtime: Double }
struct ProjectFilesResult: Codable { var files: [String]; var truncated: Bool? }
struct RunCommandResult: Codable { var runId: String }
struct AssetImageResult: Codable { var dataUrl: String? }

/// A streamed chunk from a `runCommand` process (event name `cmd-output`).
struct CmdOutput: Codable {
    var runId: String
    var stream: String        // "out" | "err" | "exit"
    var chunk: String?
    var code: Int?
}

extension MaestroClient {
    func listDir(_ projectId: String, _ path: String = "") async throws -> ListDirResult {
        try await call("listDir", ["projectId": projectId, "path": path], as: ListDirResult.self)
    }
    func readFile(_ projectId: String, _ path: String) async throws -> ReadFileResult {
        try await call("readFile", ["projectId": projectId, "path": path], as: ReadFileResult.self)
    }
    @discardableResult
    func writeFile(_ projectId: String, _ path: String, _ text: String) async throws -> WriteFileResult {
        try await call("writeFile", ["projectId": projectId, "path": path, "text": text], as: WriteFileResult.self)
    }
    func listProjectFiles(_ projectId: String) async throws -> [String] {
        try await call("listProjectFiles", ["projectId": projectId], as: ProjectFilesResult.self).files
    }
    func runCommand(_ projectId: String, _ command: String) async throws -> String {
        try await call("runCommand", ["projectId": projectId, "command": command], as: RunCommandResult.self).runId
    }
    func killCommand(_ runId: String) async { _ = try? await callVoid("killCommand", ["runId": runId]) }
    func assetImage(_ assetId: String) async throws -> String? {
        try await call("assetImage", ["assetId": assetId], as: AssetImageResult.self).dataUrl
    }
}
