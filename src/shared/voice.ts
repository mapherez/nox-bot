// Browser-safe NoX Voice contracts. No deployment URLs or credentials.
export const voiceNames = [
  "NATF0",
  "NATF1",
  "NATF2",
  "NATF3",
  "NATM0",
  "NATM1",
  "NATM2",
  "NATM3",
  "VARF0",
  "VARF1",
  "VARF2",
  "VARF3",
  "VARF4",
  "VARM0",
  "VARM1",
  "VARM2",
  "VARM3",
  "VARM4",
] as const;
export const quantizationBits = [0, 4, 5, 6, 8] as const;
export interface VoiceSettings {
  voice: string;
  prompt: string;
  bits: number;
}
export interface EngineStatus {
  state: string;
  phase: string;
  error: string | null;
  conversationActive: boolean;
  settingsChanging: boolean;
  memoryBytes: number;
  uptimeSeconds: number;
}
export interface VoiceChannel {
  id: string;
  name: string;
}
export interface VoiceStatus {
  configured: boolean;
  active: boolean;
  state: "inactive" | "starting" | "active" | "error" | "stopping";
  error?: string;
  channelId?: string;
  ownsConversation: boolean;
  controller: "ready" | "unavailable";
  engine?: EngineStatus;
  settings?: VoiceSettings;
}
