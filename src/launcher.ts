/**
 * Starts every microservice as an independent process (one container on Render/Railway).
 * Each process can also be started alone, e.g. `node dist/services/fleet.js`,
 * and pointed to the others with the *_URL environment variables.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
const processes = [
  "services/auth",
  "services/fleet",
  "services/hospital",
  "services/dispatch",
  "services/incident",
  "gateway",
  ...(process.env.SIM_ENABLED === "false" ? [] : ["simulator"]),
];

const children = processes.map((name) => {
  const file = fileURLToPath(new URL(`./${name}${ext}`, import.meta.url));
  const child = spawn(process.execPath, [...process.execArgv, file], { stdio: "inherit", env: process.env });
  child.on("exit", (code) => {
    console.error(`[launcher] ${name} exited with code ${code}, shutting down`);
    shutdown(1);
  });
  return child;
});

function shutdown(code = 0) {
  for (const child of children) if (child.exitCode === null) child.kill("SIGTERM");
  process.exit(code);
}

process.on("SIGTERM", () => shutdown(0));
process.on("SIGINT", () => shutdown(0));
