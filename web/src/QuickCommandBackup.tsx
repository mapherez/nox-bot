import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type {
  GuildSnapshot,
  QuickCommandDTO,
} from "../../src/shared/dashboard";
import {
  parseQuickCommandBackup,
  QUICK_COMMAND_BACKUP_MAX_BYTES,
  type QuickCommandBackupEntry,
} from "../../src/shared/quickCommandBackup";
import { request } from "./api";
import { Drawer, Notice } from "./components";
import s from "./App.module.css";

interface Preview {
  commands: QuickCommandBackupEntry[];
  expectedRevisions: Record<string, string>;
  created: number;
  updated: number;
  preserved: number;
  filename: string;
}
export default function QuickCommandBackup({
  guildId,
  serverName,
  csrf,
  commands,
  writable,
  saving,
  onImported,
  onNotice,
  onError,
}: {
  guildId: string;
  serverName: string;
  csrf: string;
  commands: QuickCommandDTO[];
  writable: boolean;
  saving: boolean;
  onImported: (snapshot: GuildSnapshot) => void;
  onNotice: (message: string) => void;
  onError: (message: string) => void;
}) {
  const [open, setOpen] = useState(false),
    [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [failure, setFailure] = useState("");
  const root = useRef<HTMLDivElement>(null),
    menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null),
    file = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const menuId = `quick-backup-menu-${guildId}`;
  const closeMenu = (focus = false) => {
    setOpen(false);
    if (focus) trigger.current?.focus();
  };
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!open) return;
    menu.current
      ?.querySelector<HTMLButtonElement>("button:not(:disabled)")
      ?.focus();
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target))
        setOpen(false);
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);
  const keys = (event: KeyboardEvent) => {
    if (!open) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        setOpen(true);
      }
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      setOpen(false);
      return;
    }
    const items = [
      ...(menu.current?.querySelectorAll<HTMLButtonElement>(
        '[role="menuitem"]:not(:disabled)',
      ) ?? []),
    ];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? items.length - 1
          : event.key === "ArrowDown"
            ? (index + 1) % items.length
            : event.key === "ArrowUp"
              ? (index - 1 + items.length) % items.length
              : undefined;
    if (next !== undefined) {
      event.preventDefault();
      items[next]?.focus();
    }
  };
  const exportCommands = async () => {
    closeMenu(true);
    setBusy(true);
    onError("");
    onNotice("");
    try {
      const content = await request<QuickCommandBackupEntry[]>(
        `/dashboard/api/guilds/${guildId}/quick-commands/export`,
      );
      if (!alive.current) return;
      const blob = new Blob([JSON.stringify(content, null, 2) + "\n"], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob),
        anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `nox-quick-commands-${guildId}-${new Date().toISOString().slice(0, 10)}.json`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
      onNotice(
        `Exported ${content.length} commands, including disabled commands.`,
      );
    } catch (cause) {
      if (alive.current) onError((cause as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const choose = async (selectedFile: File) => {
    setBusy(true);
    onError("");
    onNotice("");
    setFailure("");
    try {
      if (selectedFile.size > QUICK_COMMAND_BACKUP_MAX_BYTES)
        throw new Error("Choose a JSON backup smaller than 16 MiB.");
      let content: unknown;
      try {
        content = JSON.parse(
          (await selectedFile.text()).replace(/^\uFEFF/, ""),
        );
      } catch {
        throw new Error("The selected file is not valid JSON.");
      }
      const parsed = parseQuickCommandBackup(content, guildId);
      if (!parsed.length)
        throw new Error("This backup contains no commands to import.");
      const existing = new Map(
        commands.map((command) => [command.trigger, command.revision]),
      );
      const expectedRevisions = Object.fromEntries(
        parsed.map((command) => [
          command.trigger,
          existing.get(command.trigger) ?? "0",
        ]),
      );
      if (
        new Blob([JSON.stringify({ commands: parsed, expectedRevisions })])
          .size > QUICK_COMMAND_BACKUP_MAX_BYTES
      )
        throw new Error(
          "This backup is too large to import in one request (16 MiB maximum).",
        );
      const updated = parsed.filter((command) =>
        existing.has(command.trigger),
      ).length;
      if (alive.current)
        setPreview({
          commands: parsed,
          expectedRevisions,
          created: parsed.length - updated,
          updated,
          preserved: commands.length - updated,
          filename: selectedFile.name,
        });
    } catch (cause) {
      if (alive.current) onError((cause as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  const importCommands = async () => {
    if (!preview || !writable || saving || busy) return;
    setBusy(true);
    setFailure("");
    try {
      const snapshot = await request<GuildSnapshot>(
        `/dashboard/api/guilds/${guildId}/quick-commands/import`,
        {
          method: "POST",
          csrf,
          body: {
            commands: preview.commands,
            expectedRevisions: preview.expectedRevisions,
          },
        },
      );
      if (!alive.current) return;
      onImported(snapshot);
      onNotice(`Imported ${preview.commands.length} commands.`);
      setPreview(undefined);
    } catch (cause) {
      if (alive.current) setFailure((cause as Error).message);
    } finally {
      if (alive.current) setBusy(false);
    }
  };
  return (
    <>
      <div className={s.quickBackup} ref={root} onKeyDown={keys}>
        <button
          ref={trigger}
          type="button"
          className={`${s.secondary} ${s.backupTrigger}`}
          aria-label="Quick command backup options"
          aria-haspopup="menu"
          aria-expanded={open}
          aria-controls={menuId}
          disabled={busy || saving}
          onClick={() => setOpen(!open)}
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
          >
            <circle cx="12" cy="5" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="12" cy="19" r="2" />
          </svg>
        </button>
        {open && (
          <div
            ref={menu}
            id={menuId}
            role="menu"
            aria-label="Quick command backups"
            className={s.backupMenu}
          >
            <button
              type="button"
              role="menuitem"
              onClick={() => void exportCommands()}
            >
              Export commands
            </button>
            <button
              type="button"
              role="menuitem"
              disabled={!writable}
              onClick={() => {
                closeMenu(true);
                file.current?.click();
              }}
            >
              Import commands
            </button>
          </div>
        )}
      </div>
      <input
        ref={file}
        type="file"
        accept=".json,application/json"
        hidden
        aria-label="Import Quick Commands JSON"
        onChange={(event) => {
          const selectedFile = event.target.files?.[0];
          event.target.value = "";
          if (selectedFile) void choose(selectedFile);
        }}
      />
      {preview && (
        <Drawer
          title="Import commands"
          subtitle={`Restore Quick Commands to ${serverName}`}
          dirty={false}
          close={() => {
            if (!busy) {
              setPreview(undefined);
              trigger.current?.focus();
            }
          }}
          footer={
            <button
              type="button"
              className={s.primary}
              disabled={busy || saving || !writable}
              onClick={() => void importCommands()}
            >
              {busy ? "Importing…" : "Import commands"}
            </button>
          }
        >
          <p className={s.backupFilename}>{preview.filename}</p>
          <p>
            {preview.commands.length} commands:{" "}
            <strong>{preview.created} new</strong> and{" "}
            <strong>{preview.updated} updates</strong>.
          </p>
          <Notice>
            Commands with the same trigger will be updated. Their responses and
            enabled/disabled state will come from the backup. The other{" "}
            {preview.preserved} existing commands will be kept.
          </Notice>
          {failure && <Notice error>{failure}</Notice>}
          {!writable && (
            <Notice>Wait for synchronization before importing commands.</Notice>
          )}
        </Drawer>
      )}
    </>
  );
}
