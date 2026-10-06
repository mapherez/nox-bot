import type { PluginPanelProps } from "./types";
import s from "../App.module.css";
export default function DictionaryPanel({ plugin }: PluginPanelProps) {
  return (
    <div className={s.form}>
      <div className={s.preview}>
        <span className={s.pluginSymbol}>Aa</span>
        <div>
          <strong>Every word, a little closer.</strong>
          <p>Portuguese definitions from Priberam.</p>
        </div>
      </div>
      <section>
        <h3>Made for Portuguese</h3>
        <p>
          Accent correction uses the bundled Portuguese dictionary. Definitions
          include images when available, with a direct Priberam link as a
          fallback.
        </p>
        <div className={s.commandPreview}>
          <code>/definition word:coração</code>
          <span>Private reply · Images and definitions</span>
        </div>
      </section>
      <section>
        <h3>Ready to use</h3>
        <p>
          No API key or server settings are required. Enable {plugin.name} from
          the Plugins page to make its command available.
        </p>
      </section>
    </div>
  );
}
