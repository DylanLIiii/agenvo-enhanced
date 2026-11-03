// Install pinned public binaries into an explicit test directory. No login or
// user configuration is copied. Pins are reproducible test baselines.
import {
  mkdir,
  writeFile,
  chmod,
  appendFile,
  copyFile,
} from "node:fs/promises";
import { resolve, join, delimiter } from "node:path";
import { execa } from "execa";
import { createHash } from "node:crypto";
const directory = process.argv[2];
if (!directory)
  throw new Error("Usage: node scripts/install-test-runtimes.mjs <directory>");
const root = resolve(directory),
  bin = join(root, "bin");
await mkdir(bin, { recursive: true });
const os = { linux: "linux", darwin: "macos", win32: "windows" }[
  process.platform
];
const arch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
if (!os || !arch)
  throw new Error("No native test runtime for this platform/architecture");
const manifest = await fetch(
  "https://releases.herdr.dev/core/0.1.15/manifest.json",
).then((r) => {
  if (!r.ok) throw new Error(`Herdr Core manifest: ${r.status}`);
  return r.json();
});
const asset = manifest.targets[`${os}-${arch}`];
if (!asset?.url || !/^[a-f0-9]{64}$/.test(asset.sha256))
  throw new Error("Missing Herdr Core asset or SHA-256");
const response = await fetch(asset.url);
if (!response.ok) throw new Error(`Herdr Core download: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
if (createHash("sha256").update(bytes).digest("hex") !== asset.sha256)
  throw new Error("Herdr Core asset digest mismatch");
const archive = join(
  root,
  process.platform === "win32" ? "hc.zip" : "hc.tar.gz",
);
await writeFile(archive, bytes);
await execa("tar", ["-xf", archive, "-C", bin]);
const executable = join(
  bin,
  process.platform === "win32" ? "herdr-core.exe" : "herdr-core",
);
if (process.platform === "win32")
  await copyFile(executable, join(bin, "hc.exe"));
else {
  await chmod(executable, 0o755);
  await execa("ln", ["-sf", "herdr-core", join(bin, "hc")]);
}
await execa(
  "npm",
  [
    "install",
    "--prefix",
    root,
    "--no-audit",
    "--no-fund",
    "--save-exact",
    "@openai/codex@0.160.1",
    "@getpaseo/cli@0.11.1",
    "@ampcode/cli@0.0.1791446565-g95411c",
    "lody@0.104.0",
    "opencode-ai@1.18.35",
    "t3@0.1.6",
  ],
  { maxBuffer: 1024 * 1024 },
);
// The T3 launcher downloads and verifies its native runtime on first use.
// Warm a test-only cache here so the bounded system suite does not download
// it separately, and never needs the operator's T3 data directory.
const t3Home = join(root, "t3-runtime");
await mkdir(t3Home, { recursive: true });
const t3Env = {
  PATH: process.env.PATH,
  HOME: t3Home,
  T3CODE_HOME: t3Home,
  ...(process.platform === "win32"
    ? {
        SystemRoot: process.env.SystemRoot,
        WINDIR: process.env.WINDIR,
        COMSPEC: process.env.COMSPEC,
        PATHEXT: process.env.PATHEXT,
        USERPROFILE: t3Home,
        TEMP: t3Home,
        TMP: t3Home,
      }
    : {}),
};
const t3Version = await execa(
  process.execPath,
  [join(root, "node_modules", "t3", "bin", "t3.mjs"), "--version"],
  { env: t3Env, extendEnv: false },
);
if (!/^t3 v0\.1\.6\b/.test(t3Version.stdout))
  throw new Error(`Unexpected T3 Code test version: ${t3Version.stdout}`);
const paths = [bin, join(root, "node_modules", ".bin")];
if (process.env.GITHUB_PATH)
  await appendFile(process.env.GITHUB_PATH, paths.join("\n") + "\n");
if (process.env.GITHUB_ENV)
  await appendFile(process.env.GITHUB_ENV, `AGENVO_T3CODE_HOME=${t3Home}\n`);
console.log(`Add to PATH: ${paths.join(delimiter)}`);
console.log(`Set AGENVO_T3CODE_HOME=${t3Home} for system tests`);
