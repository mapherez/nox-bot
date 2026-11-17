import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { config, git, releaseRequest } from "./ci-policy.mjs";
import { release } from "./release.mjs";

function fixture(t) {
  const temp = mkdtempSync(join(tmpdir(), "release-flow-"));
  t.after(() => rmSync(temp, { recursive: true, force: true }));
  const root = join(temp, "work"),
    remote = join(temp, "origin.git");
  mkdirSync(root);
  git(temp, "init", "--bare", remote);
  git(root, "init", "-b", config.branch);
  for (const [key, value] of Object.entries({
    "user.name": "Release Test",
    "user.email": "release@example.invalid",
    "commit.gpgsign": "false",
    "tag.gpgsign": "false",
    "core.hooksPath": join(temp, "no-hooks"),
  }))
    git(root, "config", key, value);
  const source = fileURLToPath(new URL("../", import.meta.url));
  for (const spec of config.files) {
    const path = join(root, spec.path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, readFileSync(join(source, spec.path)));
  }
  git(root, "add", ".");
  git(root, "commit", "-m", "Source");
  git(root, "remote", "add", "origin", remote);
  git(root, "push", "origin", config.branch);
  return { root, remote, sourceSha: git(root, "rev-parse", "HEAD") };
}

void test("release atomically pushes only version metadata and its annotated tag", (t) => {
  const f = fixture(t),
    result = release("9.9.9-rc.1", { root: f.root, cwd: f.root });
  assert.deepEqual(
    releaseRequest(f.root, result.revision, { requireTag: true, expectedTag: result.tag }),
    { tag: result.tag, sourceSha: f.sourceSha },
  );
  assert.equal(git(f.remote, "rev-parse", `refs/heads/${config.branch}`), result.revision);
  assert.equal(git(f.remote, "rev-parse", `${result.tag}^{commit}`), result.revision);
  assert.equal(git(f.root, "status", "--porcelain"), "");
});

void test("dirty and unpushed source stop before the version is edited", (t) => {
  const f = fixture(t),
    before = readFileSync(join(f.root, "package.json"), "utf8");
  writeFileSync(join(f.root, "pending.txt"), "source");
  assert.throws(() => release("9.9.9", { root: f.root, cwd: f.root }), /Commit and push/);
  git(f.root, "add", ".");
  git(f.root, "commit", "-m", "Unpushed");
  assert.throws(() => release("9.9.9", { root: f.root, cwd: f.root }), /Push the source/);
  assert.equal(readFileSync(join(f.root, "package.json"), "utf8"), before);
  assert.equal(git(f.root, "tag", "--list"), "");
});

void test("failed commit restores all version files; rejected push preserves recovery state", (t) => {
  const f = fixture(t),
    before = config.files.map((spec) => readFileSync(join(f.root, spec.path), "utf8"));
  const hook = join(f.root, ".git", "hooks", "pre-commit");
  writeFileSync(hook, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  git(f.root, "config", "core.hooksPath", ".git/hooks");
  assert.throws(
    () => release("9.9.9", { root: f.root, cwd: f.root }),
    /Original versions restored/,
  );
  assert.deepEqual(
    config.files.map((spec) => readFileSync(join(f.root, spec.path), "utf8")),
    before,
  );
  assert.equal(git(f.root, "rev-parse", "HEAD"), f.sourceSha);
  git(f.root, "config", "core.hooksPath", "no-hooks");
  git(f.remote, "config", "receive.denyNonFastForwards", "true");
  writeFileSync(join(f.remote, "hooks", "pre-receive"), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  assert.throws(() => release("9.9.9", { root: f.root, cwd: f.root }), /remain local/);
  assert.equal(git(f.remote, "rev-parse", `refs/heads/${config.branch}`), f.sourceSha);
  assert.equal(git(f.root, "rev-parse", "v9.9.9^{commit}"), git(f.root, "rev-parse", "HEAD"));
});

void test("the installed push hook reuses CI for a release and still checks ordinary source pushes", (t) => {
  const f = fixture(t),
    source = fileURLToPath(new URL("../scripts/", import.meta.url));
  mkdirSync(join(f.root, "scripts"));
  for (const file of ["git-hooks.mjs", "dev-checks.json", "ci-policy.mjs", "ci-config.json"]) {
    writeFileSync(join(f.root, "scripts", file), readFileSync(join(source, file)));
  }
  const manifestPath = join(f.root, "package.json"),
    manifest = JSON.parse(readFileSync(manifestPath));
  manifest.scripts = { prepush: 'node -e "process.exit(37)"' };
  writeFileSync(manifestPath, JSON.stringify(manifest));
  mkdirSync(join(f.root, ".githooks"));
  writeFileSync(
    join(f.root, ".githooks", "pre-push"),
    "#!/bin/sh\nexec node scripts/git-hooks.mjs push\n",
    { mode: 0o755 },
  );
  git(f.root, "add", ".");
  git(f.root, "commit", "-m", "Hook policy");
  git(f.root, "push", "origin", config.branch);
  git(f.root, "config", "core.hooksPath", ".githooks");
  const result = release("9.9.9", { root: f.root, cwd: f.root });
  assert.equal(git(f.remote, "rev-parse", `refs/heads/${config.branch}`), result.revision);
  writeFileSync(join(f.root, "source.txt"), "ordinary source change");
  git(f.root, "add", ".");
  git(f.root, "commit", "-m", "Source change");
  assert.throws(() => git(f.root, "push", "origin", config.branch));
  assert.equal(git(f.remote, "rev-parse", `refs/heads/${config.branch}`), result.revision);
});
