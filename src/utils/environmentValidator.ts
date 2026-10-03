import Logger from "./logger.js";

class EnvironmentValidator {
  static validate(env: NodeJS.ProcessEnv = process.env) {
    const required = ["DISCORD_TOKEN", "CLIENT_ID"];

    const missing = required.filter((key) => !env[key]);

    if (missing.length > 0) {
      Logger.error(
        `Missing required environment variables: ${missing.join(", ")}`
      );
      Logger.info(
        "Please check your .env file and ensure all required variables are set."
      );
      throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
    }

    // Validate token format (basic check)
    if (
      !env.DISCORD_TOKEN ||
      !env.DISCORD_TOKEN.startsWith("MT") ||
      env.DISCORD_TOKEN.length < 50
    ) {
      Logger.warn(
        "DISCORD_TOKEN appears to be invalid. Please check your bot token."
      );
    }

    // Validate client ID format (should be numeric)
    if (!env.CLIENT_ID || !/^\d+$/.test(env.CLIENT_ID)) {
      Logger.warn(
        "CLIENT_ID appears to be invalid. It should be a numeric ID."
      );
    }

    Logger.success("Environment validation passed");
  }
}

export default EnvironmentValidator;
