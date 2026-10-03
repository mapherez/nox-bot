import "dotenv/config";
import Application from "./services/application.js";
import Logger from "./utils/logger.js";

const application = new Application();
application.start().catch((error: unknown) => {
  Logger.error("Failed to start bot:", error);
  process.exit(1);
});
