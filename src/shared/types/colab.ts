export type ColabGpuTier = "T4" | "L4" | "A100";

export type ColabManagedConfig = {
  gpu: ColabGpuTier;
  mountDriveCache: boolean;
  idleShutdownMinutes: number;
};

export type ColabRuntimeLifecycle =
  | "idle"
  | "provisioning"
  | "bootstrapping"
  | "ready"
  | "stopping"
  | "error";

export type ColabRuntimeStatusView = {
  state: ColabRuntimeLifecycle;
  endpoint: string | null;
  gpu: ColabGpuTier;
  activePreset: string | null;
  driveMounted: boolean;
  idleShutdownAt: string | null;
  ccuBalance: number | null;
  lastMessage: string | null;
};

export type ColabManagedStateResponse = {
  config: ColabManagedConfig;
  status: ColabRuntimeStatusView;
};

export const DEFAULT_COLAB_MANAGED_CONFIG: ColabManagedConfig = {
  gpu: "L4",
  mountDriveCache: true,
  idleShutdownMinutes: 15,
};
