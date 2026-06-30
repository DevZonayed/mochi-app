import Foundation

/// Decode a server-pushed event payload (arbitrary JSON `Any`) into a Codable type.
func decodeJSON<T: Decodable>(_ any: Any?, as: T.Type = T.self) -> T? {
    guard let any, let data = try? JSONSerialization.data(withJSONObject: any) else { return nil }
    return try? JSONDecoder().decode(T.self, from: data)
}

/// Cast an event payload to a dictionary (for flags like `deleted` that aren't on the model).
func asDict(_ any: Any?) -> [String: Any]? { any as? [String: Any] }
