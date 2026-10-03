import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export async function writeBuildInfo(directory = "dist", env = process.env) {
  await mkdir(directory, { recursive: true });
  const version = env.NOX_DISCORD_BUILD_VERSION?.trim() || "dev";
  await writeFile(join(directory, "build-info.json"), `${JSON.stringify({ version })}\n`, "utf8");
}
