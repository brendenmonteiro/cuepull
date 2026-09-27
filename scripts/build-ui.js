// Builds the client as a static export for the desktop app.
// Sets BUILD_TARGET=desktop without needing cross-env.
const { spawnSync } = require("child_process");
const path = require("path");

const clientDir = path.join(__dirname, "..", "client");
// shell: true is required on Windows because npx is a .cmd shim, which CreateProcess
// cannot execute directly.
const res = spawnSync("npx next build", {
  cwd: clientDir,
  env: { ...process.env, BUILD_TARGET: "desktop" },
  stdio: "inherit",
  shell: true,
});
process.exit(res.status ?? 1);
