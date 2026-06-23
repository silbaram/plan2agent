import type { P2AApi } from "../shared/ipc";

declare global {
  interface Window {
    p2a: P2AApi;
  }
}

export {};
