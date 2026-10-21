/**
 * The only place that talks to the desktop backend.
 *
 * Everything else in the frontend depends on the {@link Bridge} interface, so
 * the app can run against the real Tauri commands or against the development
 * preview without changing any other module.
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import {
  appError,
  parseAppError,
  parseAppErrors,
  parseCapabilities,
  parseHistoryRecords,
  parseRecoveryCheckpoint,
  parseSettings,
  parseSnapshot,
  type AppError,
  type Capabilities,
  type ExportFormat,
  type HistoryRecord,
  type RecoveryCheckpoint,
  type SaveSettingsRequest,
  type Settings,
  type Snapshot,
  type TimerCommandRequest,
  type WindowAction
} from "./contract";
import { createDemoBridge } from "./demo-bridge";

export type BridgeKind = "native" | "demo";

export interface Bridge {
  readonly kind: BridgeKind;
  getSnapshot(): Promise<Snapshot>;
  timerCommand(request: TimerCommandRequest): Promise<Snapshot>;
  getSettings(): Promise<Settings>;
  saveSettings(request: SaveSettingsRequest): Promise<Settings>;
  getCapabilities(): Promise<Capabilities>;
  /** The redacted diagnostics document as pretty JSON. */
  getDiagnostics(): Promise<string>;
  /** The warnings that are still relevant, for example a storage failure. */
  getWarnings(): Promise<AppError[]>;
  /** The checkpoint of an interrupted session, when there is one. */
  getRecovery(): Promise<RecoveryCheckpoint | null>;
  windowAction(action: WindowAction): Promise<void>;
  listHistory(limit: number, before?: string): Promise<HistoryRecord[]>;
  exportHistory(format: ExportFormat): Promise<string | null>;
  deleteHistory(): Promise<void>;
  confirmHistory(phaseId: string): Promise<void>;
  /** Subscribe to published snapshots. Returns an unsubscribe function. */
  subscribeSnapshot(listener: (snapshot: Snapshot) => void): Promise<() => void>;
  /** Subscribe to warnings. Returns an unsubscribe function. */
  subscribeWarning(listener: (error: AppError) => void): Promise<() => void>;
}

let requestCounter = 0;

/** A unique id for every command, so the backend can ignore duplicates. */
export function newRequestId(): string {
  requestCounter += 1;
  const cryptoApi = typeof globalThis.crypto !== "undefined" ? globalThis.crypto : undefined;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  return `req-${Date.now().toString(36)}-${requestCounter.toString(36)}`;
}

/** Turn whatever the backend rejected with into a structured error. */
export function toAppError(value: unknown): AppError {
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const code = record["code"];
    const message = record["message"];
    if (typeof code === "string" && typeof message === "string") {
      const snapshot = record["snapshot"];
      if (snapshot !== undefined && snapshot !== null) {
        try {
          return appError(code, message, parseSnapshot(snapshot));
        } catch {
          return appError(code, message);
        }
      }
      return appError(code, message);
    }
  }
  if (value instanceof Error) {
    return appError("INTERNAL", value.message);
  }
  if (typeof value === "string" && value.length > 0) {
    return appError("INTERNAL", value);
  }
  return appError("INTERNAL", "The desktop app did not explain the failure.");
}

/** Bridge that calls the real Tauri commands. */
export function createNativeBridge(): Bridge {
  return {
    kind: "native",

    async getSnapshot(): Promise<Snapshot> {
      return parseSnapshot(await invoke("get_snapshot"));
    },

    async timerCommand(request: TimerCommandRequest): Promise<Snapshot> {
      return parseSnapshot(await invoke("timer_command", { request }));
    },

    async getSettings(): Promise<Settings> {
      return parseSettings(await invoke("get_settings"));
    },

    async saveSettings(request: SaveSettingsRequest): Promise<Settings> {
      return parseSettings(await invoke("save_settings", { request }));
    },

    async getCapabilities(): Promise<Capabilities> {
      return parseCapabilities(await invoke("get_capabilities"));
    },

    async getDiagnostics(): Promise<string> {
      return await invoke<string>("get_diagnostics");
    },

    async getWarnings(): Promise<AppError[]> {
      return parseAppErrors(await invoke("get_warnings"));
    },

    async getRecovery(): Promise<RecoveryCheckpoint | null> {
      return parseRecoveryCheckpoint(await invoke("get_recovery"));
    },

    async windowAction(action: WindowAction): Promise<void> {
      await invoke("window_action", { action });
    },

    async listHistory(limit: number, before?: string): Promise<HistoryRecord[]> {
      const payload: { limit: number; before?: string } = { limit };
      if (before) {
        payload.before = before;
      }
      return parseHistoryRecords(await invoke("list_history", payload));
    },

    async exportHistory(format: ExportFormat): Promise<string | null> {
      const result = await invoke("export_history", { format });
      if (result === null || result === undefined) {
        return null;
      }
      if (typeof result === "string") {
        return result;
      }
      return null;
    },

    async deleteHistory(): Promise<void> {
      await invoke("delete_history", { confirmation: "DELETE" });
    },

    async confirmHistory(phaseId: string): Promise<void> {
      await invoke("confirm_history", { phaseId });
    },

    async subscribeSnapshot(listener: (snapshot: Snapshot) => void): Promise<() => void> {
      const unlisten = await listen<unknown>("timer:snapshot", (event) => {
        try {
          listener(parseSnapshot(event.payload));
        } catch {
          // A snapshot that cannot be understood is ignored; the next
          // published snapshot or a refresh restores the truth.
        }
      });
      return () => {
        unlisten();
      };
    },

    async subscribeWarning(listener: (error: AppError) => void): Promise<() => void> {
      const unlisten = await listen<unknown>("timer:error", (event) => {
        try {
          listener(parseAppError(event.payload));
        } catch {
          // A warning that cannot be understood is ignored rather than
          // shown as something the backend never said.
        }
      });
      return () => {
        unlisten();
      };
    }
  };
}

/**
 * True when the development preview was requested with `?demo=1`.
 *
 * The preview is only available in a development build. A failing native
 * bridge never falls back to the preview.
 */
export function isDemoRequested(doc: Document = document): boolean {
  if (!import.meta.env.DEV) {
    return false;
  }
  const search = doc.defaultView?.location.search ?? "";
  try {
    return new URLSearchParams(search).get("demo") === "1";
  } catch {
    return false;
  }
}

/**
 * True when the preview should pretend that a session was interrupted.
 *
 * This is a development aid for looking at the recovery path.
 */
export function isDemoRecoveryRequested(doc: Document = document): boolean {
  const search = doc.defaultView?.location.search ?? "";
  try {
    return new URLSearchParams(search).get("recovery") === "1";
  } catch {
    return false;
  }
}

/**
 * True when the preview should pretend that the storage is not writable.
 *
 * This is a development aid for looking at the warning path.
 */
export function isDemoWarningRequested(doc: Document = document): boolean {
  const search = doc.defaultView?.location.search ?? "";
  try {
    return new URLSearchParams(search).get("warning") === "1";
  } catch {
    return false;
  }
}

/** Build the bridge the app should use. */
export function createBridge(doc: Document = document): Bridge {
  if (isDemoRequested(doc)) {
    return createDemoBridge({
      recovery: isDemoRecoveryRequested(doc),
      warning: isDemoWarningRequested(doc)
    });
  }
  return createNativeBridge();
}
