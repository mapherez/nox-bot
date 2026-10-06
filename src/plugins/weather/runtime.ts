import type { PluginContext, PluginRuntime, RichContent } from "../sdk.js";
interface GeoLocation {
  lat: number;
  lon: number;
  name: string;
  country: string;
}
interface WeatherData {
  main: {
    temp: number;
    feels_like: number;
    humidity: number;
    pressure?: number;
  };
  wind?: { speed?: number };
  weather: Array<{ description: string; icon: string }>;
  visibility?: number;
}
async function request<T>(url: URL): Promise<T> {
  const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
  if (!response.ok)
    throw Object.assign(new Error("Weather service unavailable."), {
      status: response.status,
    });
  return (await response.json()) as T;
}
async function weather(context: PluginContext): Promise<RichContent> {
  const key = context.secrets.apiKey;
  if (!key)
    return {
      content:
        "Weather is not configured for this server. Ask the owner to configure it in the dashboard.",
    };
  const location = String(
    context.options.location || context.settings.defaultLocation,
  );
  try {
    const geoUrl = new URL("https://api.openweathermap.org/geo/1.0/direct");
    geoUrl.search = new URLSearchParams({
      q: location,
      limit: "1",
      appid: key,
    }).toString();
    const locations = await request<GeoLocation[]>(geoUrl),
      geo = locations[0];
    if (!geo)
      return {
        content: `Could not find “${location}”. Try a different city name.`,
      };
    const imperial = context.settings.units === "fahrenheit";
    const url = new URL("https://api.openweathermap.org/data/2.5/weather");
    url.search = new URLSearchParams({
      lat: String(geo.lat),
      lon: String(geo.lon),
      appid: key,
      units: imperial ? "imperial" : "metric",
    }).toString();
    const data = await request<WeatherData>(url),
      conditions = data.weather[0];
    const fields = [
      {
        name: "Temperature",
        value: `${Math.round(data.main.temp)}°${imperial ? "F" : "C"} · feels like ${Math.round(data.main.feels_like)}°`,
        inline: true,
      },
      { name: "Humidity", value: `${data.main.humidity}%`, inline: true },
      {
        name: "Wind",
        value: `${Math.round((data.wind?.speed ?? 0) * (imperial ? 1 : 3.6))} ${imperial ? "mph" : "km/h"}`,
        inline: true,
      },
    ];
    if (data.main.pressure)
      fields.push({
        name: "Pressure",
        value: `${data.main.pressure} hPa`,
        inline: true,
      });
    if (data.visibility !== undefined)
      fields.push({
        name: "Visibility",
        value: `${Math.round(data.visibility / 1000)} km`,
        inline: true,
      });
    return {
      embeds: [
        {
          color: 0x8b5cf6,
          title: `Weather in ${geo.name}, ${geo.country}`,
          description: conditions.description,
          fields,
          thumbnail: {
            url: `https://openweathermap.org/img/wn/${conditions.icon}@2x.png`,
          },
          timestamp: new Date().toISOString(),
          footer: { text: "OpenWeatherMap · NoX Bot" },
        },
      ],
      components: [
        {
          kind: "button",
          label: "Refresh weather",
          action: "refresh",
          style: "primary",
        },
      ],
    };
  } catch (error) {
    const status =
      error && typeof error === "object" && "status" in error
        ? error.status
        : null;
    return {
      content:
        status === 401
          ? "The Weather API key was rejected. Ask the owner to replace it in the dashboard."
          : status === 429
            ? "Weather request limit reached. Please try again later."
            : "Could not fetch weather right now. Please try again later.",
    };
  }
}
const runtime: PluginRuntime = {
  handlers: { weather },
  components: { refresh: weather },
};
export default runtime;
