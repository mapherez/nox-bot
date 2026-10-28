import { useCallback, useEffect, useRef, useState } from "react";
import type { PluginPanelProps } from "./types";
import { request } from "../api";
import { Badge, Notice } from "../components";
import {
  voiceNames,
  quantizationBits,
  type VoiceSettings,
  type VoiceStatus,
  type VoiceChannel,
} from "../../../src/shared/voice";
import s from "../App.module.css";

export default function VoicePanel({
  plugin,
  guildId,
  csrf,
  writable,
  saving,
  error,
  onDirty,
  save,
}: PluginPanelProps) {
  const base = `/dashboard/api/guilds/${guildId}/voice`;
  const [channel, setChannel] = useState(
    String(plugin.configuration.settings.channelId ?? ""),
  );
  const [channels, setChannels] = useState<VoiceChannel[]>([]);
  const [status, setStatus] = useState<VoiceStatus>();
  const [settings, setSettings] = useState<VoiceSettings>();
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [diagnostics, setDiagnostics] = useState<unknown>();
  const loaded = useRef(false),
    alive = useRef(true),
    polling = useRef(false);
  const channelDirty = channel !== plugin.configuration.settings.channelId;
  const engineDirty =
    !!settings &&
    !!status?.settings &&
    JSON.stringify(settings) !== JSON.stringify(status.settings);
  useEffect(
    () => onDirty(channelDirty || engineDirty),
    [channelDirty, engineDirty, onDirty],
  );
  const refresh = useCallback(async () => {
    if (polling.current) return;
    polling.current = true;
    try {
      const value = await request<VoiceStatus>(`${base}/status`);
      if (!alive.current) return;
      setStatus(value);
      if (!loaded.current && value.settings) {
        setSettings(value.settings);
        loaded.current = true;
      }
    } catch (cause) {
      if (alive.current) setNotice((cause as Error).message);
    } finally {
      polling.current = false;
    }
  }, [base]);
  useEffect(() => {
    alive.current = true;
    void request<VoiceChannel[]>(`${base}/channels`)
      .then((value) => {
        if (alive.current) setChannels(value);
      })
      .catch((cause) => {
        if (alive.current) setNotice((cause as Error).message);
      });
    void refresh();
    const timer = setInterval(() => void refresh(), 3000);
    return () => {
      alive.current = false;
      clearInterval(timer);
    };
  }, [base, refresh]);
  const operation = async (work: () => Promise<void>) => {
    setBusy(true);
    setNotice("");
    try {
      await work();
    } catch (cause) {
      if (alive.current) setNotice((cause as Error).message);
    } finally {
      if (alive.current) {
        setBusy(false);
        await refresh();
      }
    }
  };
  const apply = async () => {
    if (!settings) return;
    const value = await request<VoiceSettings>(`${base}/settings`, {
      method: "PUT",
      body: settings,
      csrf,
    });
    if (alive.current) {
      setSettings(value);
      setStatus((current) =>
        current ? { ...current, settings: value } : current,
      );
    }
  };
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!channel) {
      setNotice("Select a voice channel before saving.");
      return;
    }
    await operation(async () => {
      if (engineDirty) await apply();
      if (channelDirty) await save({ channelId: channel });
    });
  };
  const action = (name: "start" | "stop" | "restart") =>
    operation(async () => {
      await request(`${base}/engine/${name}`, {
        method: "POST",
        body: {},
        csrf,
      });
    });
  const locked = !writable || busy || saving;
  const otherConversation =
    !!status?.engine?.conversationActive && !status.ownsConversation;
  return (
    <form
      id="plugin-settings"
      className={s.form}
      onSubmit={(event) => void submit(event)}
    >
      <section>
        <h3>Discord voice channel</h3>
        <p className={s.hint}>
          Everyone in this channel can talk to the bot and hear its replies.
          Audio is processed live; conversations are not recorded.
        </p>
        <label htmlFor="voice-channel">Channel</label>
        <select
          id="voice-channel"
          value={channel}
          onChange={(event) => setChannel(event.target.value)}
          disabled={locked}
          required
        >
          <option value="">Choose a voice channel</option>
          {channels.map((value) => (
            <option key={value.id} value={value.id}>
              {value.name}
            </option>
          ))}
        </select>
        <p className={s.hint}>
          Save the channel, then enable the plugin from its card. The
          nox-voice-mlx service must already be ready and free. Changing
          channels starts a fresh conversation.
        </p>
      </section>
      <section>
        <div className={s.sectionHeading}>
          <h3>Connection and engine</h3>
          <Badge tone={status?.active ? "green" : "muted"}>
            {status?.state ?? "Checking…"}
          </Badge>
        </div>
        <p>
          Controller: {status?.controller ?? "checking"} · Engine:{" "}
          {status?.engine?.phase ?? "unavailable"}
        </p>
        {status?.engine && (
          <p className={s.hint}>
            Memory: {(status.engine.memoryBytes / 1073741824).toFixed(1)} GiB ·
            Uptime: {Math.floor(status.engine.uptimeSeconds / 60)} min
          </p>
        )}
        {(status?.error || status?.engine?.error) && (
          <Notice error>{status.error || status.engine?.error}</Notice>
        )}
        {otherConversation && (
          <Notice>
            The voice service is in use by another conversation. End it before
            changing engine settings.
          </Notice>
        )}
        <div className={s.rowActions}>
          <button
            type="button"
            className={s.secondary}
            disabled={
              locked ||
              !status?.configured ||
              otherConversation ||
              status?.engine?.state === "starting" ||
              status?.engine?.state === "ready"
            }
            onClick={() => void action("start")}
          >
            Start engine
          </button>
          <button
            type="button"
            className={s.secondary}
            disabled={locked || !status?.configured || otherConversation}
            onClick={() => void action("stop")}
          >
            Stop engine
          </button>
          <button
            type="button"
            className={s.secondary}
            disabled={locked || !status?.configured || otherConversation}
            onClick={() => void action("restart")}
          >
            Restart engine
          </button>
        </div>
        <p className={s.hint}>
          Starting the engine does not enable voice. Stopping or restarting it
          disconnects Discord voice; enable the plugin again afterwards.
          Disabling the plugin leaves the voice service running.
        </p>
        <button
          type="button"
          className={s.secondary}
          disabled={busy}
          onClick={() =>
            void operation(async () => {
              setDiagnostics(await request(`${base}/diagnostics`));
            })
          }
        >
          Test connection and diagnostics
        </button>
        {diagnostics !== undefined && (
          <pre className={s.voiceDiagnostics}>
            {JSON.stringify(diagnostics, null, 2)}
          </pre>
        )}
      </section>
      <section>
        <h3>Voice settings</h3>
        <p className={s.hint}>
          Shared with the dedicated NoX Voice webapp. Applying settings during
          Discord voice starts a fresh conversation while keeping the bot in the
          channel.
        </p>
        {settings ? (
          <>
            <label htmlFor="voice-name">Voice</label>
            <select
              id="voice-name"
              value={settings.voice}
              disabled={locked || otherConversation}
              onChange={(event) =>
                setSettings({ ...settings, voice: event.target.value })
              }
            >
              {voiceNames.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>
            <label htmlFor="voice-prompt">Persona / prompt</label>
            <textarea
              id="voice-prompt"
              maxLength={4096}
              rows={5}
              value={settings.prompt}
              disabled={locked || otherConversation}
              onChange={(event) =>
                setSettings({ ...settings, prompt: event.target.value })
              }
            />
            <label htmlFor="voice-bits">Quantization</label>
            <select
              id="voice-bits"
              value={settings.bits}
              disabled={locked || otherConversation}
              onChange={(event) =>
                setSettings({ ...settings, bits: Number(event.target.value) })
              }
            >
              {quantizationBits.map((bits) => (
                <option key={bits} value={bits}>
                  {bits === 0 ? "Original precision" : `${bits}-bit`}
                </option>
              ))}
            </select>
            <p className={s.hint}>
              Quantization changes memory use and can affect voice quality.
            </p>
            <button
              type="button"
              className={s.primary}
              disabled={
                locked ||
                !engineDirty ||
                otherConversation ||
                status?.engine?.settingsChanging
              }
              onClick={() => void operation(apply)}
            >
              {status?.ownsConversation
                ? "Apply and restart conversation"
                : "Apply voice settings"}
            </button>
            <button
              type="button"
              className={s.secondary}
              disabled={locked}
              onClick={() => {
                void operation(async () => {
                  const current = await request<VoiceStatus>(`${base}/status`);
                  if (alive.current) {
                    setStatus(current);
                    if (current.settings) setSettings(current.settings);
                  }
                });
              }}
            >
              Reload current settings
            </button>
          </>
        ) : (
          <p className={s.hint}>
            Voice settings will appear when the nox-voice-mlx controller is
            available.
          </p>
        )}
      </section>
      {notice && <Notice error>{notice}</Notice>}
      {error && <Notice error>{error}</Notice>}
      {!writable && (
        <Notice>
          Reconnecting — configuration changes temporarily unavailable. Your
          draft is kept here.
        </Notice>
      )}
      <button type="submit" hidden disabled={locked}>
        Apply changes
      </button>
    </form>
  );
}
