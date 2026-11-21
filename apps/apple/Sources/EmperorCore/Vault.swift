import Foundation
import Security

public protocol CredentialVault: Sendable {
    func read(_ key: String) throws -> Credentials?
    func write(_ credentials: Credentials, for key: String) throws
    func remove(_ key: String) throws
}

/// Each app has its own Keychain sandbox. Tokens never enter UserDefaults.
public struct KeychainVault: CredentialVault {
    private let service = "com.emperorclaw.mobile.credentials"
    public init() {}
    private func query(_ key: String) -> [String: Any] {
        [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: service, kSecAttrAccount as String: key]
    }
    public func read(_ key: String) throws -> Credentials? {
        var request = query(key)
        request[kSecReturnData as String] = true; request[kSecMatchLimit as String] = kSecMatchLimitOne
        var result: CFTypeRef?
        let status = SecItemCopyMatching(request as CFDictionary, &result)
        if status == errSecItemNotFound { return nil }
        guard status == errSecSuccess, let data = result as? Data else { throw VaultError(status: status) }
        return try JSONDecoder().decode(Credentials.self, from: data)
    }
    public func write(_ credentials: Credentials, for key: String) throws {
        let data = try JSONEncoder().encode(credentials)
        let values: [String: Any] = [kSecValueData as String: data, kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly]
        let status = SecItemUpdate(query(key) as CFDictionary, values as CFDictionary)
        if status == errSecItemNotFound {
            var request = query(key); values.forEach { request[$0.key] = $0.value }
            let inserted = SecItemAdd(request as CFDictionary, nil)
            guard inserted == errSecSuccess else { throw VaultError(status: inserted) }
        } else if status != errSecSuccess { throw VaultError(status: status) }
    }
    public func remove(_ key: String) throws {
        let status = SecItemDelete(query(key) as CFDictionary)
        guard status == errSecSuccess || status == errSecItemNotFound else { throw VaultError(status: status) }
    }
}

private struct VaultError: LocalizedError {
    let status: OSStatus
    var errorDescription: String? { "Secure storage is unavailable (\(status)). Unlock your device and try again." }
}
