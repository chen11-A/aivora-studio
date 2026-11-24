import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createSecretVault } from "../auth/secret-vault";
import { GlobalConfigStore } from "./global-store";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "aivora-global-"));
  tempDirs.push(dir);
  return dir;
}

const mockVault = createSecretVault({
  isEncryptionAvailable: () => true,
  getSelectedStorageBackend: () => "dpapi",
  encryptString: (plain) => Buffer.from(plain.split("").reverse().join(""), "utf8"),
  decryptString: (buf) => buf.toString("utf8").split("").reverse().join(""),
});

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("GlobalConfigStore", () => {
  it("encrypts API keys (never writing plaintext to SQLite), persists routing, and cleans up on delete", () => {
    const dir = makeTempDir();
    const store1 = new GlobalConfigStore(dir, mockVault);

    const initial = store1.getSnapshot();
    expect(initial.vaultAvailable).toBe(true);
    expect(initial.oauthAccounts.map((a) => a.providerId)).toEqual(["chatgpt-web", "grok-web"]);

    const provider = store1.saveProvider({
      name: "可灵官方",
      protocol: "kling-video",
      baseUrl: "https://api-beijing.klingai.com",
      models: ["kling-v2-master"],
      apiKey: "AK_SUPER_SECRET_9988",
      secondaryKey: "SK_SUPER_SECRET_7766",
      enabled: true,
    });

    expect(provider.hasSecret).toBe(true);
    expect(provider.keyHint).toBe("••••9988");

    store1.updateRouting({
      script: { source: "oauth", sourceId: "chatgpt-web", modelId: "gpt-4.1" },
      image: { source: "oauth", sourceId: "grok-web", modelId: "grok-imagine-image" },
      video: { source: "provider", sourceId: provider.id, modelId: "kling-v2-master" },
      tts: null,
    });
    store1.close();

    // Ensure raw SQLite file never contains plaintext secret
    const rawDb = readFileSync(join(dir, "global.db"));
    expect(rawDb.includes(Buffer.from("AK_SUPER_SECRET_9988"))).toBe(false);
    expect(rawDb.includes(Buffer.from("SK_SUPER_SECRET_7766"))).toBe(false);

    // Reopen and verify routing + cleanup on delete
    const store2 = new GlobalConfigStore(dir, mockVault);
    const snap = store2.getSnapshot();
    expect(snap.routing.video?.sourceId).toBe(provider.id);
    expect(snap.routing.script?.sourceId).toBe("chatgpt-web");

    store2.deleteProvider(provider.id);
    const afterDelete = store2.getSnapshot();
    expect(afterDelete.providers).toHaveLength(0);
    expect(afterDelete.routing.video).toBeNull();
    expect(afterDelete.routing.script?.sourceId).toBe("chatgpt-web");
    store2.close();
  });

  it("edits existing provider while preserving encrypted API keys when key fields are omitted, and persists custom OAuth models", () => {
    const dir = makeTempDir();
    const store1 = new GlobalConfigStore(dir, mockVault);

    const created = store1.saveProvider({
      name: "Colab L4",
      protocol: "comfy-worker",
      baseUrl: "https://old-tunnel.trycloudflare.com",
      models: ["flux-schnell"],
      apiKey: "SECRET_TOKEN_1122",
      enabled: true,
    });

    // Update URL and models WITHOUT re-entering apiKey -> must keep original encrypted key!
    const edited = store1.saveProvider({
      id: created.id,
      name: "Colab L4 (新隧道)",
      protocol: "comfy-worker",
      baseUrl: "https://new-tunnel.trycloudflare.com",
      models: ["flux-schnell", "wan2.2-i2v-5b"],
      enabled: true,
    });
    expect(edited.id).toBe(created.id);
    expect(edited.baseUrl).toBe("https://new-tunnel.trycloudflare.com");
    expect(edited.hasSecret).toBe(true);
    expect(edited.keyHint).toBe("••••1122");

    const creds = store1.getProviderCredentials(created.id);
    expect(creds?.apiKey).toBe("SECRET_TOKEN_1122");

    // Customize OAuth account models and verify persistence across reopen
    const afterOAuth = store1.updateOAuthModels("chatgpt-web", [
      "gpt-4.1",
      "gpt-image-1",
      "gpt-image-1",
    ]);
    expect(
      afterOAuth.oauthAccounts.find((a) => a.providerId === "chatgpt-web")?.models,
    ).toEqual(["gpt-4.1", "gpt-image-1"]);
    store1.close();

    const store2 = new GlobalConfigStore(dir, mockVault);
    expect(
      store2.getSnapshot().oauthAccounts.find((a) => a.providerId === "chatgpt-web")?.models,
    ).toEqual(["gpt-4.1", "gpt-image-1"]);
    store2.close();
  });
});
