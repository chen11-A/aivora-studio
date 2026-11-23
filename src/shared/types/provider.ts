import { z } from "zod";

export const OAuthProviderIdSchema = z.enum(["chatgpt-web", "grok-web"]);
export type OAuthProviderId = z.infer<typeof OAuthProviderIdSchema>;

export const OAuthAccountStatusSchema = z.enum([
  "disconnected",
  "awaiting_browser",
  "connected",
  "expired",
  "entitlement_denied",
]);
export type OAuthAccountStatus = z.infer<typeof OAuthAccountStatusSchema>;

export const OAuthAccountViewSchema = z.object({
  providerId: OAuthProviderIdSchema,
  displayName: z.string(),
  status: OAuthAccountStatusSchema,
  accountLabel: z.string().nullable(),
  models: z.array(z.string()),
  note: z.string().nullable(),
  updatedAt: z.string().nullable(),
});
export type OAuthAccountView = z.infer<typeof OAuthAccountViewSchema>;

export const CustomProviderProtocolSchema = z.enum([
  "openai-chat",
  "openai-image",
  "openai-tts",
  "kling-video",
  "video-async-experimental",
]);
export type CustomProviderProtocol = z.infer<typeof CustomProviderProtocolSchema>;

export const ProviderConfigViewSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).max(80),
  protocol: CustomProviderProtocolSchema,
  baseUrl: z.string().url(),
  models: z.array(z.string().min(1)),
  hasSecret: z.boolean(),
  keyHint: z.string().nullable(),
  enabled: z.boolean(),
  lastTestOk: z.boolean().nullable(),
  lastTestMessage: z.string().nullable(),
  updatedAt: z.string(),
});
export type ProviderConfigView = z.infer<typeof ProviderConfigViewSchema>;

export const SaveProviderConfigInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(1, "请输入厂家名称").max(80),
  protocol: CustomProviderProtocolSchema,
  baseUrl: z.string().trim().url("请输入有效的接口地址（http/https）"),
  apiKey: z.string().optional(),
  secondaryKey: z.string().optional(),
  models: z.array(z.string().trim().min(1)).default([]),
  enabled: z.boolean().default(true),
});
export type SaveProviderConfigInput = z.infer<typeof SaveProviderConfigInputSchema>;

export const CapabilityKeySchema = z.enum(["script", "image", "video", "tts"]);
export type CapabilityKey = z.infer<typeof CapabilityKeySchema>;

export const RouteBindingSchema = z.object({
  source: z.enum(["oauth", "provider"]),
  sourceId: z.string().min(1),
  modelId: z.string().min(1),
});
export type RouteBinding = z.infer<typeof RouteBindingSchema>;

export const ModelRoutingSchema = z.object({
  script: RouteBindingSchema.nullable().default(null),
  image: RouteBindingSchema.nullable().default(null),
  video: RouteBindingSchema.nullable().default(null),
  tts: RouteBindingSchema.nullable().default(null),
});
export type ModelRouting = z.infer<typeof ModelRoutingSchema>;

export const ModelCenterSnapshotSchema = z.object({
  vaultAvailable: z.boolean(),
  oauthAccounts: z.array(OAuthAccountViewSchema),
  providers: z.array(ProviderConfigViewSchema),
  routing: ModelRoutingSchema,
});
export type ModelCenterSnapshot = z.infer<typeof ModelCenterSnapshotSchema>;
