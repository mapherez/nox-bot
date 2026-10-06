import { ApplicationCommandOptionType } from "discord.js";
import {
  noSettings,
  noSecrets,
  plainSettings,
  type PluginDefinition,
} from "./sdk.js";

export const builtInPlugins: readonly PluginDefinition[] = [
  {
    id: "weather",
    name: "Weather",
    description: "Current conditions, wherever you are.",
    version: "1.0.0",
    icon: "sun",
    runtimeEntry: "./weather/runtime.js",
    dashboardEntry: "weather",
    capabilities: ["http", "interactive"],
    componentHandlers: ["refresh"],
    commands: [
      {
        name: "weather",
        description: "Get current weather information",
        handler: "weather",
        usage: "/weather [location]",
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: "location",
            description: "City name (defaults to your server setting)",
            required: false,
            max_length: 200,
          },
        ],
      },
    ],
    defaults: { units: "celsius", defaultLocation: "London" },
    secretFields: ["apiKey"],
    validateSettings(value) {
      const data = plainSettings(value);
      if (
        Object.keys(data).some(
          (key) => !["units", "defaultLocation"].includes(key),
        ) ||
        !["celsius", "fahrenheit"].includes(String(data.units)) ||
        typeof data.defaultLocation !== "string" ||
        !data.defaultLocation.trim() ||
        data.defaultLocation.length > 200
      )
        throw new Error(
          "Choose valid units and a default location (1–200 characters).",
        );
      return {
        units: String(data.units),
        defaultLocation: data.defaultLocation.trim(),
      };
    },
    validateSecrets(value) {
      if (
        Object.keys(value).some((key) => key !== "apiKey") ||
        !value.apiKey?.trim() ||
        value.apiKey.length > 512 ||
        /\s/.test(value.apiKey)
      )
        throw new Error(
          "A Weather API key is required before enabling the plugin.",
        );
    },
  },
  {
    id: "dictionary",
    name: "Dictionary",
    description: "Portuguese definitions, with smart accent correction.",
    version: "1.0.0",
    icon: "book",
    runtimeEntry: "./dictionary/runtime.js",
    dashboardEntry: "dictionary",
    capabilities: ["http", "attachments"],
    commands: [
      {
        name: "definition",
        description: "Get a Portuguese word definition from Priberam",
        handler: "definition",
        usage: "/definition <word>",
        options: [
          {
            type: ApplicationCommandOptionType.String,
            name: "word",
            description: "Portuguese word to define",
            required: true,
            max_length: 100,
          },
        ],
      },
    ],
    defaults: {},
    secretFields: [],
    validateSettings: noSettings,
    validateSecrets: noSecrets,
  },
  {
    id: "userinfo",
    name: "User Info",
    description: "Account details and membership at a glance.",
    version: "1.0.0",
    icon: "user",
    runtimeEntry: "./userinfo/runtime.js",
    dashboardEntry: "userinfo",
    capabilities: ["discord-users"],
    commands: [
      {
        name: "userinfo",
        description: "Get information about a user",
        handler: "userinfo",
        usage: "/userinfo [user]",
        options: [
          {
            type: ApplicationCommandOptionType.User,
            name: "user",
            description: "User to inspect (defaults to you)",
            required: false,
          },
        ],
      },
    ],
    defaults: {},
    secretFields: [],
    validateSettings: noSettings,
    validateSecrets: noSecrets,
  },
  {
    id: "ping",
    name: "Ping",
    description: "A quick check of the bot’s response time.",
    version: "1.0.0",
    icon: "activity",
    runtimeEntry: "./ping/runtime.js",
    dashboardEntry: "ping",
    capabilities: [],
    commands: [
      {
        name: "ping",
        description: "Test bot response time",
        handler: "ping",
        usage: "/ping",
      },
    ],
    defaults: {},
    secretFields: [],
    validateSettings: noSettings,
    validateSecrets: noSecrets,
  },
];
