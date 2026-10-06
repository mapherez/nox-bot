import type { PluginPanelProps } from "./types";
import s from "../App.module.css";
export default function PingPanel(_: PluginPanelProps) {
  return (
    <div className={s.form}>
      <div className={s.preview}>
        <span className={s.pluginSymbol}>↗</span>
        <div>
          <strong>A quick connection check.</strong>
          <p>See how quickly NoX Bot receives your command.</p>
        </div>
      </div>
      <section>
        <h3>Instant feedback</h3>
        <p>
          Ping reports interaction latency with a private response. Useful when
          checking that your server's bot is responding.
        </p>
        <div className={s.commandPreview}>
          <code>/ping</code>
          <span>Private reply · No settings required</span>
        </div>
      </section>
    </div>
  );
}
