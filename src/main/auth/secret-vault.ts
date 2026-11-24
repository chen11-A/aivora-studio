export interface SafeStorageLike {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend?(): string;
  encryptString(plainText: string): Buffer;
  decryptString(encrypted: Buffer): string;
}

export class SecretVaultError extends Error {
  constructor(
    readonly code: "VAULT_UNAVAILABLE" | "VAULT_CORRUPT",
    message: string,
  ) {
    super(message);
  }
}

export interface SecretVault {
  isAvailable(): boolean;
  encryptToBase64(plainText: string): string;
  decryptFromBase64(cipherBase64: string): string;
}

/**
 * Ported security boundary from aijian-studio grok-auth-storage.ts:
 * refuses Electron's `basic_text` plaintext fallback so credentials are never stored unencrypted.
 */
export function createSecretVault(storage: SafeStorageLike): SecretVault {
  const isAvailable = () => {
    try {
      return (
        storage.isEncryptionAvailable() && storage.getSelectedStorageBackend?.() !== "basic_text"
      );
    } catch {
      return false;
    }
  };

  return {
    isAvailable,
    encryptToBase64(plainText: string): string {
      if (!isAvailable()) {
        throw new SecretVaultError(
          "VAULT_UNAVAILABLE",
          "系统安全凭据库（DPAPI / Keychain / Linux Secret Service）不可用，已拒绝明文保存密钥。",
        );
      }
      return storage.encryptString(plainText).toString("base64");
    },
    decryptFromBase64(cipherBase64: string): string {
      if (!isAvailable()) {
        throw new SecretVaultError(
          "VAULT_UNAVAILABLE",
          "系统安全凭据库当前不可用，无法读取已保存密钥。",
        );
      }
      try {
        return storage.decryptString(Buffer.from(cipherBase64, "base64"));
      } catch {
        throw new SecretVaultError("VAULT_CORRUPT", "已保存的加密密钥无法解密，请重新保存。");
      }
    },
  };
}
