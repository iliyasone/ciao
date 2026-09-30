import type { CiaoApi } from "../preload/preload";

declare global {
  interface Window {
    ciao: CiaoApi;
  }
  const ciao: CiaoApi;
}
