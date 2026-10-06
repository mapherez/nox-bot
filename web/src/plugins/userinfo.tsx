import type { PluginPanelProps } from "./types";
import s from "../App.module.css";
export default function UserInfoPanel(_: PluginPanelProps) {
  return (
    <div className={s.form}>
      <div className={s.preview}>
        <span className={s.pluginSymbol}>◎</span>
        <div>
          <strong>Meet the people in your server.</strong>
          <p>Discord identity, roles and membership at a glance.</p>
        </div>
      </div>
      <section>
        <h3>Member profile</h3>
        <p>
          View account creation, server join date, avatar and roles. Without a
          selected user, the command shows your own profile.
        </p>
        <div className={s.commandPreview}>
          <code>/userinfo user:@member</code>
          <span>Private reply · Live Discord data</span>
        </div>
      </section>
      <section>
        <h3>No configuration needed</h3>
        <p>
          Member information comes directly from Discord and stays scoped to
          this server.
        </p>
      </section>
    </div>
  );
}
