import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import type {
  GuildSnapshot,
  GuildDTO,
  ChannelDTO,
  SessionDTO,
  PluginCard,
  QuickCommandDTO,
  Settings,
} from "../../src/shared/dashboard";
import { ApiError, request } from "./api";
import { Badge, Drawer, Notice, Switch } from "./components";
import { panels } from "./pluginCatalog";
import s from "./App.module.css";
type Page = "Server" | "Plugins" | "Quick Commands";
type Editing =
  | { type: "plugin"; plugin: PluginCard }
  | { type: "quick"; command: QuickCommandDTO; fresh: boolean };
const symbols: Record<string, string> = {
  sun: "☀",
  book: "Aa",
  user: "◎",
  activity: "↗",
};
function QuickForm({
  command,
  fresh,
  writable,
  saving,
  error,
  onDirty,
  save,
}: {
  command: QuickCommandDTO;
  fresh: boolean;
  writable: boolean;
  saving: boolean;
  error: string;
  onDirty: (value: boolean) => void;
  save: (value: QuickCommandDTO) => Promise<boolean>;
}) {
  const [trigger, setTrigger] = useState(command.trigger),
    [response, setResponse] = useState(command.response),
    [enabled, setEnabled] = useState(command.enabled),
    [invalid, setInvalid] = useState("");
  const dirty =
    trigger !== command.trigger ||
    response !== command.response ||
    enabled !== command.enabled;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  return (
    <form
      id="quick-settings"
      className={s.form}
      onSubmit={(event) => {
        event.preventDefault();
        const normalized = trigger.trim().toLowerCase();
        if (
          !/^[a-z0-9_-]{1,32}$/.test(normalized) ||
          normalized === "help" ||
          !response.trim() ||
          response.length > 2000
        ) {
          setInvalid(
            "Use a trigger of 1–32 letters, numbers, underscores or hyphens (except help), and a response of 1–2000 characters.",
          );
          return;
        }
        setInvalid("");
        void save({
          trigger: normalized,
          response,
          enabled,
          revision: command.revision,
        });
      }}
    >
      <section>
        <h3>A shortcut for the things you say often.</h3>
        <p className={s.hint}>
          Quick Commands send a public message and attempt to clean up the
          input. Extra arguments are ignored.
        </p>
        <label htmlFor="quick-trigger">Trigger</label>
        <div className={s.inputPrefix}>
          <span>!</span>
          <input
            id="quick-trigger"
            value={trigger}
            onChange={(event) => setTrigger(event.target.value)}
            disabled={!fresh}
            maxLength={32}
            required
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <p className={s.hint}>
          Case insensitive. The trigger “help” is reserved.
        </p>
        <label htmlFor="quick-response">Response</label>
        <textarea
          id="quick-response"
          value={response}
          onChange={(event) => setResponse(event.target.value)}
          rows={8}
          maxLength={2000}
          required
          aria-describedby="response-count"
        />
        <p className={s.counter} id="response-count">
          {response.length} / 2000
        </p>
        <div className={s.sectionHeading}>
          <div>
            <h3>Enabled</h3>
            <p className={s.hint}>
              Include this command in !help and /nox commands.
            </p>
          </div>
          <Switch
            checked={enabled}
            label="Enable Quick Command"
            onChange={setEnabled}
          />
        </div>
      </section>
      {invalid && <Notice error>{invalid}</Notice>}
      {error && <Notice error>{error}</Notice>}
      {!writable && (
        <Notice>
          Reconnecting — configuration changes temporarily unavailable. Your
          draft is kept here.
        </Notice>
      )}
      <button type="submit" hidden disabled={!writable || saving}>
        Save command
      </button>
    </form>
  );
}
export default function App() {
  const [session, setSession] = useState<SessionDTO | null>(),
    [guilds, setGuilds] = useState<GuildDTO[]>([]),
    [guildId, setGuildId] = useState(""),
    [page, setPage] = useState<Page>("Server");
  const [snapshot, setSnapshot] = useState<GuildSnapshot>(),
    [channels, setChannels] = useState<ChannelDTO[]>([]),
    [connected, setConnected] = useState(true),
    [notice, setNotice] = useState(""),
    [fatal, setFatal] = useState("");
  const [editing, setEditing] = useState<Editing>(),
    [dirty, setDirty] = useState(false),
    [saving, setSaving] = useState(false),
    [error, setError] = useState(""),
    [pending, setPending] = useState("");
  const selected = useRef(guildId);
  selected.current = guildId;
  const onDirty = useCallback((value: boolean) => setDirty(value), []);
  useEffect(() => {
    let active = true;
    void request<SessionDTO>("/dashboard/api/session")
      .then(async (value) => {
        if (!active) return;
        setSession(value);
        const list = await request<GuildDTO[]>("/dashboard/api/guilds");
        if (active) {
          setGuilds(list);
          setGuildId(list[0]?.id ?? "");
        }
      })
      .catch((cause) => {
        if (!active) return;
        if (cause instanceof ApiError && cause.status === 401) setSession(null);
        else {
          setFatal(
            cause instanceof Error
              ? cause.message
              : "Could not connect to the dashboard.",
          );
          setSession(null);
        }
      });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    if (!guildId || !session) return;
    let active = true;
    setSnapshot(undefined);
    setChannels([]);
    setConnected(true);
    setNotice("");
    const apply = (value: GuildSnapshot) => {
      if (!active || selected.current !== value.guildId) return;
      setSnapshot((previous) =>
        previous && BigInt(value.revision) < BigInt(previous.revision)
          ? previous
          : value,
      );
    };
    void request<GuildSnapshot>(`/dashboard/api/guilds/${guildId}`)
      .then(apply)
      .catch((cause) => {
        if (active) setNotice(cause.message);
      });
    void request<ChannelDTO[]>(`/dashboard/api/guilds/${guildId}/channels`)
      .then((value) => {
        if (active) setChannels(value);
      })
      .catch((cause) => {
        if (active) setNotice(cause.message);
      });
    const events = new EventSource(`/dashboard/api/guilds/${guildId}/events`);
    events.addEventListener("snapshot", (event) => {
      try {
        apply(JSON.parse((event as MessageEvent).data) as GuildSnapshot);
        setConnected(true);
      } catch {
        setConnected(false);
      }
    });
    events.onerror = () => {
      if (active) setConnected(false);
    };
    return () => {
      active = false;
      events.close();
    };
  }, [guildId, session]);
  const writable = !!snapshot?.writable && connected,
    server = guilds.find((guild) => guild.id === guildId);
  async function mutate(
    path: string,
    method: string,
    body: unknown,
  ): Promise<boolean> {
    if (!session || !writable) return false;
    setSaving(true);
    setError("");
    setNotice("");
    try {
      const value = await request<GuildSnapshot>(
        `/dashboard/api/guilds/${guildId}/${path}`,
        { method, body, csrf: session.csrf },
      );
      if (selected.current === value.guildId) setSnapshot(value);
      setNotice("Changes saved.");
      return true;
    } catch (cause) {
      const failure = cause as ApiError;
      setError(
        failure.code === "STATE_CONFLICT"
          ? "This configuration changed in another window. Your draft is preserved. Close and reopen it to review the latest settings."
          : failure.code === "WRITE_UNCONFIRMED"
            ? "The save result is unknown. Your draft is preserved. Wait for synchronization and review the confirmed state before saving again."
            : failure.message,
      );
      return false;
    } finally {
      setSaving(false);
      setPending("");
    }
  }
  function open(value: Editing) {
    setEditing(value);
    setDirty(false);
    setError("");
  }
  function close() {
    setEditing(undefined);
    setDirty(false);
    setError("");
  }
  function changeGuild(value: string) {
    if (
      editing &&
      dirty &&
      !window.confirm("Discard your unsaved changes and switch servers?")
    )
      return;
    close();
    setGuildId(value);
  }
  async function toggle(plugin: PluginCard, enabled: boolean) {
    setPending(plugin.id);
    if (
      !(await mutate(`plugins/${plugin.id}/enabled`, "PUT", {
        enabled,
        expectedRevision: plugin.configuration.revision,
      }))
    ) {
      setEditing({ type: "plugin", plugin });
      setDirty(false);
    }
  }
  async function savePlugin(
    settings: Settings,
    secrets?: Record<string, string | null>,
  ) {
    if (editing?.type !== "plugin") return false;
    const ok = await mutate(`plugins/${editing.plugin.id}/settings`, "PUT", {
      settings,
      secrets,
      expectedRevision: editing.plugin.configuration.revision,
    });
    if (ok) close();
    return ok;
  }
  async function saveQuick(command: QuickCommandDTO) {
    const ok = await mutate(
      `quick-commands${editing?.type === "quick" && !editing.fresh ? `/${command.trigger}` : ""}`,
      editing?.type === "quick" && !editing.fresh ? "PUT" : "POST",
      {
        trigger: command.trigger,
        response: command.response,
        enabled: command.enabled,
        expectedRevision: command.revision,
      },
    );
    if (ok) close();
    return ok;
  }
  function signOut() {
    if (!session || !window.confirm("Sign out of NoX Bot?")) return;
    if (dirty && !window.confirm("Discard your unsaved changes?")) return;
    void request("/auth/logout", {
      method: "POST",
      body: {},
      csrf: session.csrf,
    })
      .then(() => {
        close();
        setSession(null);
      })
      .catch((cause) => setNotice(cause.message));
  }
  if (session === undefined)
    return (
      <main className={s.login}>
        <div className={s.loginCard}>
          <img src="/nox.svg" width="56" height="56" alt="" />
          <h1>NoX Bot</h1>
          <p role="status">Connecting to your dashboard…</p>
        </div>
      </main>
    );
  if (session === null)
    return (
      <main className={s.login}>
        <div className={s.loginCard}>
          <img src="/nox.svg" width="56" height="56" alt="" />
          <p className={s.eyebrow}>YOUR SERVER, YOUR WAY</p>
          <h1>
            A quieter place
            <br />
            to run your bot.
          </h1>
          <p>One home for your servers, plugins and everyday shortcuts.</p>
          {new URLSearchParams(location.search).get("auth") === "denied" ? (
            <Notice error>
              Access denied. Only the configured owner can use this dashboard.
            </Notice>
          ) : new URLSearchParams(location.search).get("auth") === "failed" ? (
            <Notice error>
              Your login request expired or could not be verified. Please try
              again.
            </Notice>
          ) : null}
          {fatal && <Notice error>{fatal}</Notice>}
          <a className={s.primary} href="/auth/login">
            Continue with Discord <span aria-hidden="true">↗</span>
          </a>
          <span className={s.hint}>Owner access only · NoX Bot</span>
        </div>
        <span className={s.loginOrbit} aria-hidden="true" />
      </main>
    );
  const activeCount =
    snapshot?.plugins.filter((plugin) => plugin.configuration.enabled).length ??
    0;
  const Panel =
    editing?.type === "plugin"
      ? panels[editing.plugin.dashboardEntry]
      : undefined;
  return (
    <div className={s.shell}>
      <aside className={s.sidebar}>
        <a href="/" className={s.brand}>
          <img src="/nox.svg" width="36" height="36" alt="" />
          <strong>
            NoX<span> Bot</span>
          </strong>
        </a>
        <div className={s.serverSelect}>
          <label htmlFor="server-select">WORKSPACE</label>
          <select
            id="server-select"
            value={guildId}
            onChange={(event) => changeGuild(event.target.value)}
            disabled={!guilds.length}
          >
            {guilds.length ? (
              guilds.map((guild) => (
                <option key={guild.id} value={guild.id}>
                  {guild.name}
                </option>
              ))
            ) : (
              <option>No servers available</option>
            )}
          </select>
        </div>
        <p className={s.navLabel}>MANAGE</p>
        <nav aria-label="Main navigation">
          {(["Server", "Plugins", "Quick Commands"] as const).map((item, i) => (
            <button
              key={item}
              className={page === item ? s.selectedNav : s.navItem}
              aria-current={page === item ? "page" : undefined}
              onClick={() => setPage(item)}
            >
              <span aria-hidden="true">{["◇", "◫", "⌘"][i]}</span>
              {item}
              {item === "Plugins" && <small>{activeCount}</small>}
            </button>
          ))}
        </nav>
        <div className={s.sidebarBottom}>
          <div className={s.connection}>
            <span className={writable ? s.onlineDot : s.warningDot} />
            {writable ? "Configuration synced" : "Sync reconnecting"}
          </div>
          <div className={s.profile}>
            <span className={s.avatar}>
              {session.user.username.slice(0, 1).toUpperCase()}
            </span>
            <div>
              <strong>{session.user.username}</strong>
              <span>Owner</span>
            </div>
            <button
              aria-label="Sign out"
              className={s.iconButton}
              disabled={!writable}
              onClick={signOut}
            >
              ↪
            </button>
          </div>
        </div>
      </aside>
      <main className={s.main}>
        <header className={s.topbar}>
          <div>
            <span>{server?.name ?? "Workspace"}</span>
            <span aria-hidden="true">/</span>
            <strong>{page}</strong>
          </div>
          <div>
            <Badge tone="purple">NoX Bot</Badge>
            <button
              className={s.mobileLogout}
              disabled={!writable}
              onClick={signOut}
            >
              Sign out
            </button>
          </div>
        </header>
        <div className={s.content}>
          <div className={s.pageHeader}>
            <div>
              <p className={s.eyebrow}>YOUR WORKSPACE</p>
              <h1>{page === "Server" ? "Server overview" : page}</h1>
              <p>
                {page === "Server"
                  ? "A clear view of what’s running in your server."
                  : page === "Plugins"
                    ? "Give your server the tools it needs. Keep the rest quiet."
                    : "Small shortcuts. Fewer repeated messages."}
              </p>
            </div>
            {page === "Quick Commands" && (
              <button
                className={s.primary}
                disabled={!writable}
                onClick={() =>
                  open({
                    type: "quick",
                    fresh: true,
                    command: {
                      trigger: "",
                      response: "",
                      enabled: true,
                      revision: "0",
                    },
                  })
                }
              >
                + Add command
              </button>
            )}
          </div>
          {!writable && (
            <Notice>
              Reconnecting — configuration changes temporarily unavailable
              {snapshot
                ? ". Showing the last confirmed state. Your bot continues to run."
                : ". Waiting for confirmed configuration."}
            </Notice>
          )}
          {notice && <Notice>{notice}</Notice>}
          {error && !editing && <Notice error>{error}</Notice>}
          {!guildId ? (
            <div className={s.empty}>
              <span>◇</span>
              <h2>No servers yet</h2>
              <p>Install NoX Bot in a Discord server to see it here.</p>
            </div>
          ) : !snapshot ? (
            <div className={s.loading} role="status">
              Loading confirmed configuration…
            </div>
          ) : page === "Server" ? (
            <>
              <div className={s.metrics}>
                <article>
                  <span>Enabled plugins</span>
                  <strong>
                    {activeCount}
                    <small> / {snapshot.plugins.length}</small>
                  </strong>
                  <p>Tools available in this server</p>
                </article>
                <article>
                  <span>Quick Commands</span>
                  <strong>
                    {
                      snapshot.quickCommands.filter(
                        (command) => command.enabled,
                      ).length
                    }
                  </strong>
                  <p>Everyday shortcuts, ready to send</p>
                </article>
                <article>
                  <span>Command synchronization</span>
                  <strong className={s.metricWord}>
                    {snapshot.commandSynchronization.state === "synced"
                      ? "Up to date"
                      : snapshot.commandSynchronization.state === "error"
                        ? "Retrying"
                        : "Syncing"}
                  </strong>
                  <p>
                    {snapshot.commandSynchronization.error ??
                      "Guild commands managed automatically"}
                  </p>
                </article>
              </div>
              <div className={s.overviewGrid}>
                <section className={s.surface}>
                  <div className={s.sectionHeading}>
                    <div>
                      <h2>{server?.name}</h2>
                      <p>Your Discord server</p>
                    </div>
                    <span className={s.serverMark}>
                      {server?.name.slice(0, 2).toUpperCase()}
                    </span>
                  </div>
                  <dl className={s.details}>
                    <div>
                      <dt>Server ID</dt>
                      <dd>
                        <code>{guildId}</code>
                        <button
                          className={s.textButton}
                          onClick={() =>
                            void navigator.clipboard
                              .writeText(guildId)
                              .then(() => setNotice("Server ID copied."))
                              .catch(() =>
                                setNotice("Select the server ID to copy it."),
                              )
                          }
                        >
                          Copy
                        </button>
                      </dd>
                    </div>
                    <div>
                      <dt>Configuration</dt>
                      <dd>
                        <Badge tone={writable ? "green" : "amber"}>
                          {writable ? "Synced" : "Last confirmed state"}
                        </Badge>
                      </dd>
                    </div>
                    <div>
                      <dt>Access</dt>
                      <dd>Owner only</dd>
                    </div>
                  </dl>
                </section>
                <section className={`${s.surface} ${s.tip}`}>
                  <span className={s.eyebrow}>A LITTLE LESS REPETITION</span>
                  <h2>
                    Make room for
                    <br />
                    better conversations.
                  </h2>
                  <p>
                    Add a shortcut for your rules, links or frequently asked
                    questions.
                  </p>
                  <button
                    className={s.secondary}
                    onClick={() => setPage("Quick Commands")}
                  >
                    Explore Quick Commands <span aria-hidden="true">→</span>
                  </button>
                </section>
              </div>
              <section className={s.surface}>
                <div className={s.sectionHeading}>
                  <div>
                    <h2>Available channels</h2>
                    <p>Channels where the bot can view and send messages.</p>
                  </div>
                  <Badge>{channels.length} channels</Badge>
                </div>
                {channels.length ? (
                  <div className={s.channelGrid}>
                    {channels.map((channel) => (
                      <div key={channel.id}>
                        <span>#</span>
                        <div>
                          <strong>{channel.name}</strong>
                          <small>{channel.type}</small>
                        </div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <p className={s.hint}>
                    No sendable channels are available. Check the bot’s Discord
                    permissions.
                  </p>
                )}
              </section>
            </>
          ) : page === "Plugins" ? (
            <>
              <div className={s.sectionHeading}>
                <p className={s.hint}>
                  Built-in collection{" "}
                  <span>· {snapshot.plugins.length} plugins</span>
                </p>
                <Badge>{activeCount} enabled</Badge>
              </div>
              <div className={s.pluginGrid}>
                {snapshot.plugins.map((plugin) => (
                  <article key={plugin.id} className={s.pluginCard}>
                    <div className={s.cardTop}>
                      <div className={`${s.pluginIcon} ${s[plugin.id] ?? ""}`}>
                        {symbols[plugin.icon] ?? "◫"}
                      </div>
                      <Switch
                        checked={plugin.configuration.enabled}
                        label={`${plugin.configuration.enabled ? "Disable" : "Enable"} ${plugin.name}`}
                        disabled={!writable || saving}
                        onChange={(enabled) => void toggle(plugin, enabled)}
                      />
                    </div>
                    <h2>{plugin.name}</h2>
                    <p>{plugin.description}</p>
                    <div className={s.commands}>
                      {plugin.commands.map((command) => (
                        <code key={command.name}>/{command.name}</code>
                      ))}
                    </div>
                    <footer>
                      <Badge
                        tone={
                          plugin.configuration.runtime === "error"
                            ? "amber"
                            : plugin.configuration.enabled
                              ? "green"
                              : "muted"
                        }
                      >
                        {pending === plugin.id
                          ? "Saving…"
                          : plugin.configuration.runtime === "error"
                            ? "Runtime error"
                            : plugin.configuration.enabled
                              ? plugin.configuration.runtime === "active"
                                ? "Active"
                                : "Starting"
                              : "Disabled"}
                      </Badge>
                      <button
                        className={s.textButton}
                        onClick={() => open({ type: "plugin", plugin })}
                      >
                        Configure <span aria-hidden="true">↗</span>
                      </button>
                    </footer>
                    {plugin.configuration.error && (
                      <p className={s.fieldError}>
                        {plugin.configuration.error}
                      </p>
                    )}
                  </article>
                ))}
              </div>
              <p className={s.collectionNote}>
                Enabled plugins automatically add their commands to this server.
                All plugin responses are private.
              </p>
            </>
          ) : (
            <section className={s.surface}>
              <div className={s.sectionHeading}>
                <div>
                  <h2>Your shortcuts</h2>
                  <p>
                    Available through !help and the private /nox commands menu.
                  </p>
                </div>
                <Badge>{snapshot.quickCommands.length} commands</Badge>
              </div>
              {!snapshot.quickCommands.length ? (
                <div className={s.empty}>
                  <span>⌘</span>
                  <h2>Your first shortcut starts here</h2>
                  <p>
                    Add a command for a useful link, server rule or recurring
                    answer.
                  </p>
                  <button
                    className={s.secondary}
                    disabled={!writable}
                    onClick={() =>
                      open({
                        type: "quick",
                        fresh: true,
                        command: {
                          trigger: "",
                          response: "",
                          enabled: true,
                          revision: "0",
                        },
                      })
                    }
                  >
                    + Create Quick Command
                  </button>
                </div>
              ) : (
                <div className={s.tableScroll}>
                  <table>
                    <thead>
                      <tr>
                        <th scope="col">Trigger</th>
                        <th scope="col">Response</th>
                        <th scope="col">Status</th>
                        <th scope="col">
                          <span className={s.srOnly}>Actions</span>
                        </th>
                      </tr>
                    </thead>
                    <tbody>
                      {snapshot.quickCommands.map((command) => (
                        <tr key={command.trigger}>
                          <th scope="row">
                            <code>!{command.trigger}</code>
                          </th>
                          <td>
                            <p className={s.responseExcerpt}>
                              {command.response}
                            </p>
                          </td>
                          <td>
                            <Badge tone={command.enabled ? "green" : "muted"}>
                              {command.enabled ? "Enabled" : "Disabled"}
                            </Badge>
                          </td>
                          <td>
                            <div className={s.rowActions}>
                              <button
                                className={s.textButton}
                                onClick={() =>
                                  open({ type: "quick", command, fresh: false })
                                }
                              >
                                Edit
                                <span className={s.srOnly}>
                                  {" "}
                                  !{command.trigger}
                                </span>
                              </button>
                              <button
                                className={s.deleteButton}
                                disabled={!writable || saving}
                                aria-label={`Delete !${command.trigger}`}
                                onClick={() => {
                                  if (
                                    window.confirm(
                                      `Delete !${command.trigger}? This removes its saved response.`,
                                    )
                                  )
                                    void mutate(
                                      `quick-commands/${command.trigger}`,
                                      "DELETE",
                                      { expectedRevision: command.revision },
                                    );
                                }}
                              >
                                ×
                              </button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          )}
        </div>
        <footer className={s.pageFooter}>
          <span>NoX Bot</span>
          <span>A little more control. A little less noise.</span>
        </footer>
      </main>
      {editing && (
        <Drawer
          title={
            editing.type === "plugin"
              ? editing.plugin.name
              : editing.fresh
                ? "New Quick Command"
                : `!${editing.command.trigger}`
          }
          subtitle={
            editing.type === "plugin"
              ? `Settings for ${server?.name ?? "this server"}`
              : `Public response in ${server?.name ?? "this server"}`
          }
          dirty={dirty}
          close={close}
          footer={
            editing.type === "plugin" && !editing.plugin.configurable ? (
              <button className={s.primary} onClick={close}>
                Done
              </button>
            ) : (
              <button
                className={s.primary}
                type="submit"
                form={
                  editing.type === "plugin"
                    ? "plugin-settings"
                    : "quick-settings"
                }
                disabled={
                  !writable || saving || (editing.type === "plugin" && !dirty)
                }
              >
                {saving ? "Saving…" : "Save changes"}
              </button>
            )
          }
        >
          {editing.type === "plugin" ? (
            Panel ? (
              <Suspense
                fallback={<p role="status">Loading plugin settings…</p>}
              >
                <Panel
                  plugin={editing.plugin}
                  writable={writable}
                  saving={saving}
                  error={error}
                  onDirty={onDirty}
                  save={savePlugin}
                />
              </Suspense>
            ) : (
              <Notice error>
                This plugin’s dashboard entry is unavailable.
              </Notice>
            )
          ) : (
            <QuickForm
              command={editing.command}
              fresh={editing.fresh}
              writable={writable}
              saving={saving}
              error={error}
              onDirty={onDirty}
              save={saveQuick}
            />
          )}
        </Drawer>
      )}
    </div>
  );
}
