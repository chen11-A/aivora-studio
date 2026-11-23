import { describe, expect, it } from "vitest";
import { createSecretVault, SecretVaultError, type SafeStorageLike } from "./secret-vault";

function createFakeSafeStorage(opts: {
  available: boolean;
  backend?: string;
  corruptDecrypt?: boolean;
}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => opts.available,
    getSelectedStorageBackend: () => opts.backend ?? "dpapi",
    encryptString: (plain) => Buffer.from(`enc:${plain}`, "utf8"),
    decryptString: (buf) => {
      if (opts.corruptDecrypt) throw new Error("bad cipher");
      const raw = buf.toString("utf8");
      if (!raw.startsWith("enc:")) throw new Error("invalid prefix");
      return raw.slice(4);
    },
  };
}

describe("SecretVault", () => {
  it("encrypts and decrypts when DPAPI/Keychain backend is available", () => {
    const vault = createSecretVault(createFakeSafeStorage({ available: true, backend: "dpapi" }));
    expect(vault.isAvailable()).toBe(true);
    const cipher = vault.encryptToBase64("sk-test-123456");
    expect(cipher).not.toContain("sk-test-123456");
    expect(vault.decryptFromBase64(cipher)).toBe("sk-test-123456");
  });

  it("refuses Electron basic_text plaintext fallback", () => {
    const vault = createSecretVault(createFakeSafeStorage({ available: true, backend: "basic_text" }));
    expect(vault.isAvailable()).toBe(false);
    expect(() => vault.encryptToBase64("sk-secret")).toThrow(SecretVaultError);
    try {
      vault.encryptToBase64("sk-secret");
    } catch (err) {
      expect((err as SecretVaultError).code).toBe("VAULT_UNAVAILABLE");
    }
  });

  it("throws VAULT_CORRUPT when ciphertext cannot be decrypted", () => {
    const vault = createSecretVault(
      createFakeSafeStorage({ available: true, backend: "dpapi", corruptDecrypt: true }),
    );
    try {
      vault.decryptFromBase64(Buffer.from("garbage").toString("base64"));
      expect.unreachable();
    } catch (err) {
      expect(err).toBeInstanceOf(SecretVaultError);
      expect((err as SecretVaultError).code).toBe("VAULT_CORRUPT");
    }
  });
});
