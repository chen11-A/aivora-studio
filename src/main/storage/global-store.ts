import { randomUUID } from "node:crypto";
import { join } from "node:path";
import type { SecretVault } from "../auth/secret-vault";
import {
  SaveProviderConfigInputSchema,
  type CapabilityKey,
  type ModelCenterSnapshot,
  type ModelRouting,
  type OAuthAccountView,
  type ProviderConfigView,
  type SaveProviderConfigInput,
} from "../../shared/types/provider";
import { initGlobalSchema } from "./schema";
import { openSqlite, type SqliteDriver } from "./sqlite-driver";

type ProviderRow = {
  id: string;
  name: string;
  protocol: ProviderConfigView["protocol"];
  base_url: string;
  models_json: string;
  secret_cipher_b64: string | null;
  secondary_cipher_b64: string | null;
  key_hint: string | null;
  enabled: number;
  last_test_ok: number | null;
  last_test_message: string | null;
  updated_at: string;
};

type OAuthRow = {
  provider_id: OAuthAccountView["providerId"];
  display_name: string;
  status: OAuthAccountView["status"];
  account_label: string | null;
  models_json: string;
  note: string | null;
  updated_at: string | null;
};

type RoutingRow = {
  capability: CapabilityKey;
  source: "oauth" | "provider";
  source_id: string;
  model_id: string;
};

function makeKeyHint(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 4) return "****";
  return `••••${trimmed.slice(-4)}`;
}

export class GlobalConfigStore {
  private readonly db: SqliteDriver;

  constructor(
    appDataDir: string,
    private readonly vault: SecretVault,
  ) {
    this.db = openSqlite(join(appDataDir, "global.db"));
    initGlobalSchema(this.db);
    this.seedDefaultOAuthRows();
  }

  private seedDefaultOAuthRows(): void {
    const defaults: Array<[OAuthAccountView["providerId"], string, string]> = [
      ["chatgpt-web", "ChatGPT 官方账号", "使用系统浏览器 PKCE 授权，凭据经 Windows DPAPI 加密"],
      ["grok-web", "Grok (xAI) 账号", "支持浏览器 OAuth 与 Device Code 登录，可用于剧本/生图/视频"],
    ];
    for (const [id, name, note] of defaults) {
      this.db.run(
        `INSERT OR IGNORE INTO oauth_accounts (provider_id, display_name, status, models_json, note)
         VALUES (?, ?, 'disconnected', '[]', ?)`,
        id,
        name,
        note,
      );
    }
  }

  getSnapshot(): ModelCenterSnapshot {
    const oauthRows = this.db.all<OAuthRow>(
      `SELECT provider_id, display_name, status, account_label, models_json, note, updated_at
       FROM oauth_accounts ORDER BY provider_id ASC`,
    );
    const providerRows = this.db.all<ProviderRow>(
      `SELECT * FROM provider_configs ORDER BY updated_at DESC`,
    );
    const routingRows = this.db.all<RoutingRow>(
      `SELECT capability, source, source_id, model_id FROM model_routing`,
    );

    const routing: ModelRouting = { script: null, image: null, video: null, tts: null };
    for (const row of routingRows) {
      routing[row.capability] = {
        source: row.source,
        sourceId: row.source_id,
        modelId: row.model_id,
      };
    }

    return {
      vaultAvailable: this.vault.isAvailable(),
      oauthAccounts: oauthRows.map((row) => ({
        providerId: row.provider_id,
        displayName: row.display_name,
        status: row.status,
        accountLabel: row.account_label,
        models: JSON.parse(row.models_json) as string[],
        note: row.note,
        updatedAt: row.updated_at,
      })),
      providers: providerRows.map((row) => this.toProviderView(row)),
      routing,
    };
  }

  saveProvider(rawInput: SaveProviderConfigInput): ProviderConfigView {
    const input = SaveProviderConfigInputSchema.parse(rawInput);
    const now = new Date().toISOString();
    const id = input.id?.trim() || `prv_${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    const existing = this.db.get<ProviderRow>(`SELECT * FROM provider_configs WHERE id = ?`, id);

    let secretCipher = existing?.secret_cipher_b64 ?? null;
    let keyHint = existing?.key_hint ?? null;
    if (input.apiKey && input.apiKey.trim()) {
      secretCipher = this.vault.encryptToBase64(input.apiKey.trim());
      keyHint = makeKeyHint(input.apiKey);
    }

    let secondaryCipher = existing?.secondary_cipher_b64 ?? null;
    if (input.secondaryKey && input.secondaryKey.trim()) {
      secondaryCipher = this.vault.encryptToBase64(input.secondaryKey.trim());
    }

    this.db.run(
      `INSERT INTO provider_configs (
         id, name, protocol, base_url, models_json, secret_cipher_b64, secondary_cipher_b64,
         key_hint, enabled, last_test_ok, last_test_message, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         protocol = excluded.protocol,
         base_url = excluded.base_url,
         models_json = excluded.models_json,
         secret_cipher_b64 = excluded.secret_cipher_b64,
         secondary_cipher_b64 = excluded.secondary_cipher_b64,
         key_hint = excluded.key_hint,
         enabled = excluded.enabled,
         updated_at = excluded.updated_at`,
      id,
      input.name,
      input.protocol,
      input.baseUrl,
      JSON.stringify(input.models),
      secretCipher,
      secondaryCipher,
      keyHint,
      input.enabled ? 1 : 0,
      existing?.last_test_ok ?? null,
      existing?.last_test_message ?? null,
      now,
    );

    const saved = this.db.get<ProviderRow>(`SELECT * FROM provider_configs WHERE id = ?`, id);
    if (!saved) throw new Error("保存模型厂家失败");
    return this.toProviderView(saved);
  }

  deleteProvider(providerId: string): void {
    this.db.transaction(() => {
      this.db.run(`DELETE FROM provider_configs WHERE id = ?`, providerId);
      this.db.run(`DELETE FROM model_routing WHERE source = 'provider' AND source_id = ?`, providerId);
    });
  }

  updateRouting(routing: ModelRouting): ModelRouting {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      const capabilities: CapabilityKey[] = ["script", "image", "video", "tts"];
      for (const cap of capabilities) {
        const binding = routing[cap];
        if (!binding) {
          this.db.run(`DELETE FROM model_routing WHERE capability = ?`, cap);
        } else {
          this.db.run(
            `INSERT INTO model_routing (capability, source, source_id, model_id, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(capability) DO UPDATE SET
               source = excluded.source,
               source_id = excluded.source_id,
               model_id = excluded.model_id,
               updated_at = excluded.updated_at`,
            cap,
            binding.source,
            binding.sourceId,
            binding.modelId,
            now,
          );
        }
      }
    });
    return this.getSnapshot().routing;
  }

  getProviderCredentials(providerId: string): {
    view: ProviderConfigView;
    apiKey: string;
    secondaryKey: string | null;
  } | null {
    const row = this.db.get<ProviderRow>(`SELECT * FROM provider_configs WHERE id = ?`, providerId);
    if (!row) return null;
    const apiKey = row.secret_cipher_b64 ? this.vault.decryptFromBase64(row.secret_cipher_b64) : "";
    const secondaryKey = row.secondary_cipher_b64
      ? this.vault.decryptFromBase64(row.secondary_cipher_b64)
      : null;
    return { view: this.toProviderView(row), apiKey, secondaryKey };
  }

  recordProviderTestResult(providerId: string, ok: boolean, message: string): void {
    const now = new Date().toISOString();
    this.db.run(
      `UPDATE provider_configs SET last_test_ok = ?, last_test_message = ?, updated_at = ? WHERE id = ?`,
      ok ? 1 : 0,
      message,
      now,
      providerId,
    );
  }

  saveOAuthSession(input: {
    providerId: OAuthAccountView["providerId"];
    status: OAuthAccountView["status"];
    accountLabel: string | null;
    models: string[];
    sessionPayload: Record<string, unknown> | null;
    note?: string;
  }): void {
    const now = new Date().toISOString();
    const cipher = input.sessionPayload
      ? this.vault.encryptToBase64(JSON.stringify(input.sessionPayload))
      : null;
    this.db.run(
      `UPDATE oauth_accounts
       SET status = ?, account_label = ?, models_json = ?, session_cipher_b64 = ?, note = COALESCE(?, note), updated_at = ?
       WHERE provider_id = ?`,
      input.status,
      input.accountLabel,
      JSON.stringify(input.models),
      cipher,
      input.note ?? null,
      now,
      input.providerId,
    );
  }

  loadOAuthSession<T = Record<string, unknown>>(
    providerId: OAuthAccountView["providerId"],
  ): { status: OAuthAccountView["status"]; payload: T | null } {
    const row = this.db.get<{ status: OAuthAccountView["status"]; session_cipher_b64: string | null }>(
      `SELECT status, session_cipher_b64 FROM oauth_accounts WHERE provider_id = ?`,
      providerId,
    );
    if (!row || !row.session_cipher_b64) return { status: row?.status ?? "disconnected", payload: null };
    const plain = this.vault.decryptFromBase64(row.session_cipher_b64);
    return { status: row.status, payload: JSON.parse(plain) as T };
  }

  clearOAuthSession(providerId: OAuthAccountView["providerId"]): void {
    const now = new Date().toISOString();
    this.db.transaction(() => {
      this.db.run(
        `UPDATE oauth_accounts SET status = 'disconnected', account_label = NULL, models_json = '[]', session_cipher_b64 = NULL, updated_at = ?
         WHERE provider_id = ?`,
        now,
        providerId,
      );
      this.db.run(`DELETE FROM model_routing WHERE source = 'oauth' AND source_id = ?`, providerId);
    });
  }

  close(): void {
    this.db.close();
  }

  private toProviderView(row: ProviderRow): ProviderConfigView {
    return {
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      baseUrl: row.base_url,
      models: JSON.parse(row.models_json) as string[],
      hasSecret: Boolean(row.secret_cipher_b64),
      keyHint: row.key_hint,
      enabled: row.enabled === 1,
      lastTestOk: row.last_test_ok === null ? null : row.last_test_ok === 1,
      lastTestMessage: row.last_test_message,
      updatedAt: row.updated_at,
    };
  }
}
