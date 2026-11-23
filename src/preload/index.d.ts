import type { AivoraDesktopApi } from "../shared/ipc-contract";

declare global {
  interface Window {
    aivora?: AivoraDesktopApi;
  }
}

export {};
