import { useEffect, useRef, type ReactNode } from "react";
import s from "./App.module.css";
export function Badge({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "green" | "amber" | "purple";
}) {
  return <span className={`${s.badge} ${s[tone]}`}>{children}</span>;
}
export function Switch({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <button
      className={s.switch}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}
export function Drawer({
  title,
  subtitle,
  children,
  footer,
  dirty,
  close,
}: {
  title: string;
  subtitle: string;
  children: ReactNode;
  footer: ReactNode;
  dirty: boolean;
  close: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null),
    previous = useRef<Element | null>(null);
  const askClose = () => {
    if (!dirty || window.confirm("Discard your unsaved changes?")) close();
  };
  useEffect(() => {
    previous.current = document.activeElement;
    const dialog = ref.current!;
    dialog.showModal();
    const original = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      dialog.close();
      document.body.style.overflow = original;
      if (previous.current instanceof HTMLElement) previous.current.focus();
    };
  }, []);
  useEffect(() => {
    if (!dirty) return;
    const unload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener("beforeunload", unload);
    return () => window.removeEventListener("beforeunload", unload);
  }, [dirty]);
  return (
    <dialog
      ref={ref}
      className={s.drawer}
      aria-labelledby="drawer-title"
      aria-describedby="drawer-description"
      onCancel={(event) => {
        event.preventDefault();
        askClose();
      }}
      onClick={(event) => {
        if (event.target === ref.current) {
          const rect = ref.current.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right)
            askClose();
        }
      }}
    >
      <div className={s.drawerLayout}>
        <header className={s.drawerHeader}>
          <div>
            <p className={s.eyebrow}>CONFIGURATION</p>
            <h2 id="drawer-title">{title}</h2>
            <p id="drawer-description">{subtitle}</p>
          </div>
          <button
            className={s.iconButton}
            aria-label="Close configuration"
            onClick={askClose}
          >
            ×
          </button>
        </header>
        <div className={s.drawerBody}>{children}</div>
        <footer className={s.drawerFooter}>
          <button className={s.secondary} onClick={askClose}>
            Cancel
          </button>
          {footer}
        </footer>
      </div>
    </dialog>
  );
}
export function Notice({
  children,
  error = false,
}: {
  children: ReactNode;
  error?: boolean;
}) {
  return (
    <div
      className={`${s.notice} ${error ? s.error : ""}`}
      role={error ? "alert" : "status"}
    >
      {children}
    </div>
  );
}
