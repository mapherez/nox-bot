import { readFileSync, writeFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { config, git, versionTag, renderVersion, releaseRequest } from "./ci-policy.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function release(input, { root = repositoryRoot, cwd = process.cwd() } = {}) {
  const tag = versionTag(input);
  if (
    realpathSync(cwd) !== realpathSync(root) ||
    realpathSync(git(root, "rev-parse", "--show-toplevel")) !== realpathSync(root)
  ) {
    throw new Error("Run npm run release at the repository root.");
  }
  if (git(root, "status", "--porcelain=v1", "--untracked-files=all"))
    throw new Error("Commit and push all changes before releasing.");
  const branch = git(root, "symbolic-ref", "--quiet", "--short", "HEAD");
  if (config.branch && branch !== config.branch)
    throw new Error(`Release requires branch ${config.branch}.`);
  const head = git(root, "rev-parse", "HEAD");
  const remote = git(root, "ls-remote", "--heads", "origin", `refs/heads/${branch}`).split(
    /\s+/,
  )[0];
  if (remote !== head) throw new Error("Push the source commit to origin before releasing.");
  if (
    git(root, "tag", "--list", tag) ||
    git(root, "ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`)
  ) {
    throw new Error(`Tag ${tag} already exists.`);
  }
  git(root, "var", "GIT_AUTHOR_IDENT");
  git(root, "var", "GIT_COMMITTER_IDENT");
  const current = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
  if (versionTag(current) === tag) throw new Error("Choose a new release version.");
  const updates = config.files
    .map((spec) => {
      const path = join(root, spec.path);
      const original = readFileSync(path, "utf8");
      return { path, spec, original, updated: renderVersion(original, spec, tag.slice(1)) };
    })
    .filter((file) => file.original !== file.updated);
  let committed = false;
  try {
    for (const file of updates) writeFileSync(file.path, file.updated);
    const changed = git(root, "diff", "--name-only").split("\n").filter(Boolean);
    if (
      changed.some((path) => !updates.some((file) => file.spec.path === path)) ||
      git(root, "diff", "--cached", "--name-only") ||
      git(root, "ls-files", "--others", "--exclude-standard") ||
      git(root, "rev-parse", "HEAD") !== head ||
      git(root, "symbolic-ref", "--quiet", "--short", "HEAD") !== branch
    )
      throw new Error("Repository changed while preparing release.");
    git(root, "add", "--", ...updates.map((file) => file.spec.path));
    git(root, "commit", "-m", `chore: release ${tag}`, "-m", `${config.marker} ${tag}`);
    committed = true;
    const revision = git(root, "rev-parse", "HEAD");
    const request = releaseRequest(root, revision);
    if (
      request?.sourceSha !== head ||
      git(root, "status", "--porcelain=v1", "--untracked-files=all")
    )
      throw new Error("Unexpected release commit changes.");
    git(root, "tag", "-a", tag, "-m", `Release ${tag}`, revision);
    git(
      root,
      "push",
      "--atomic",
      "origin",
      `HEAD:refs/heads/${branch}`,
      `refs/tags/${tag}:refs/tags/${tag}`,
    );
    return { tag, revision };
  } catch (error) {
    if (!committed && git(root, "rev-parse", "HEAD") === head) {
      for (const file of updates) writeFileSync(file.path, file.original);
      git(root, "restore", "--staged", "--", ...updates.map((file) => file.spec.path));
      throw new Error(
        `${error.message}\nOriginal versions restored; no release commit was created.`,
      );
    }
    throw new Error(
      `${error.message}\nRelease commit/tag remain local. Inspect them, then retry the atomic push to origin.`,
    );
  }
}

async function main() {
  if (process.argv.length > 3) throw new Error("Usage: npm run release -- X.Y.Z");
  let version = process.argv[2];
  if (!version) {
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    try {
      version = await prompt.question("New version (X.Y.Z): ");
    } finally {
      prompt.close();
    }
  }
  if (!version?.trim()) throw new Error("Release cancelled.");
  const result = release(version.trim());
  console.log(
    `Published commit and tag ${result.tag}. Release reuses approved source CI; source tests are not repeated.`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
