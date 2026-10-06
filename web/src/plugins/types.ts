import type { PluginCard, Settings } from "../../../src/shared/dashboard";
export interface PluginPanelProps {
  plugin: PluginCard;
  writable: boolean;
  saving: boolean;
  error: string;
  onDirty: (dirty: boolean) => void;
  save: (
    settings: Settings,
    secrets?: Record<string, string | null>,
  ) => Promise<boolean>;
}
