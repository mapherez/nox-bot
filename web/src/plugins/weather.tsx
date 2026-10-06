import { useEffect, useState } from "react";
import type { PluginPanelProps } from "./types";
import { Badge, Notice } from "../components";
import s from "../App.module.css";
export default function WeatherPanel({
  plugin,
  writable,
  saving,
  error,
  onDirty,
  save,
}: PluginPanelProps) {
  const initial = plugin.configuration;
  const [location, setLocation] = useState(
    String(initial.settings.defaultLocation ?? "London"),
  );
  const [units, setUnits] = useState(
    String(initial.settings.units ?? "celsius"),
  );
  const [key, setKey] = useState(""),
    [removeKey, setRemoveKey] = useState(false),
    [invalid, setInvalid] = useState("");
  const dirty =
    location !== initial.settings.defaultLocation ||
    units !== initial.settings.units ||
    !!key ||
    removeKey;
  useEffect(() => onDirty(dirty), [dirty, onDirty]);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    if (!location.trim() || location.length > 200) {
      setInvalid("Enter a default location of up to 200 characters.");
      return;
    }
    setInvalid("");
    const secrets = removeKey
      ? { apiKey: null }
      : key
        ? { apiKey: key }
        : undefined;
    if (await save({ defaultLocation: location.trim(), units }, secrets)) {
      setKey("");
      setRemoveKey(false);
    }
  }
  return (
    <form
      id="plugin-settings"
      onSubmit={(event) => void submit(event)}
      className={s.form}
    >
      <div className={s.preview}>
        <span className={s.weatherSun}>☀</span>
        <div>
          <strong>A little clarity, whatever the weather.</strong>
          <p>Local forecasts with a private refresh button in Discord.</p>
        </div>
      </div>
      <section>
        <h3>Forecast preferences</h3>
        <p className={s.hint}>Applied only to this server.</p>
        <label htmlFor="weather-location">Default location</label>
        <input
          id="weather-location"
          value={location}
          onChange={(event) => setLocation(event.target.value)}
          maxLength={200}
          required
          autoComplete="off"
          aria-describedby="location-hint location-error"
          onBlur={() =>
            setInvalid(location.trim() ? "" : "Enter a default location.")
          }
        />
        <p className={s.hint} id="location-hint">
          Used when /weather is called without a location.
        </p>
        <p className={s.fieldError} id="location-error">
          {invalid}
        </p>
        <label htmlFor="weather-units">Temperature units</label>
        <select
          id="weather-units"
          value={units}
          onChange={(event) => setUnits(event.target.value)}
        >
          <option value="celsius">Celsius (°C)</option>
          <option value="fahrenheit">Fahrenheit (°F)</option>
        </select>
      </section>
      <section>
        <div className={s.sectionHeading}>
          <h3>OpenWeather API key</h3>
          <Badge tone={initial.secrets.apiKey?.configured ? "green" : "amber"}>
            {initial.secrets.apiKey?.configured ? "Configured" : "Required"}
          </Badge>
        </div>
        <p className={s.hint}>
          Encrypted for this server. The saved key is never displayed.
        </p>
        <label htmlFor="weather-key">
          {initial.secrets.apiKey?.configured ? "Replace key" : "API key"}
        </label>
        <input
          id="weather-key"
          type="password"
          value={key}
          onChange={(event) => {
            setKey(event.target.value);
            setRemoveKey(false);
          }}
          maxLength={4096}
          autoComplete="new-password"
          placeholder={
            initial.secrets.apiKey?.configured
              ? "Leave blank to keep the saved key"
              : "Paste your OpenWeather key"
          }
          disabled={removeKey}
        />
        {initial.secrets.apiKey?.configured && (
          <label className={s.checkbox}>
            <input
              type="checkbox"
              checked={removeKey}
              onChange={(event) => {
                setRemoveKey(event.target.checked);
                setKey("");
              }}
            />
            Remove the saved key
          </label>
        )}
        {removeKey && initial.enabled && (
          <Notice error>
            Disable Weather before removing its required key.
          </Notice>
        )}
      </section>
      {error && <Notice error>{error}</Notice>}
      {!writable && (
        <Notice>
          Reconnecting — configuration changes temporarily unavailable. Your
          draft is kept here.
        </Notice>
      )}
      <button type="submit" hidden disabled={!writable || saving}>
        Save changes
      </button>
    </form>
  );
}
