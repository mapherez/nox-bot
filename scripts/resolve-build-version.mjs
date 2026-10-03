import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function resolveBuildVersion(cwd = process.cwd()) {
  const git = (args) => execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const sha = git(["rev-parse", "HEAD"]);
  try { return git(["describe", "--tags", "--exact-match", "HEAD"]); }
  catch { return `git-${sha}`; }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(resolveBuildVersion());
}
