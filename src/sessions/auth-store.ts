import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { useMultiFileAuthState, type AuthenticationState, type SignalDataTypeMap } from "baileys";

export interface AuthStore {
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}

// Each session gets its own directory of auth files. Baileys writes ~hundreds of
// pre-keys + session records here; back this directory up, don't lose it.
export async function loadAuthStore(dataDir: string, sessionId: string): Promise<AuthStore> {
  const dir = join(dataDir, "sessions", sessionId);
  await mkdir(dir, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(dir);
  return { state, saveCreds };
}

export type { SignalDataTypeMap };
