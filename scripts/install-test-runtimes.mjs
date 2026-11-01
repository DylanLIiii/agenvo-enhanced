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
  ],
  { maxBuffer: 1024 * 1024 },
);
const paths = [bin, join(root, "node_modules", ".bin")];
if (process.env.GITHUB_PATH)
  await appendFile(process.env.GITHUB_PATH, paths.join("\n") + "\n");
console.log(`Add to PATH: ${paths.join(delimiter)}`);
