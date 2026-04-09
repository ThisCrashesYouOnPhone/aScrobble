#!/usr/bin/env node
/**
 * Build the Cloudflare Worker and copy the bundled output into the Tauri
 * resources directory, so `tauri build` can bundle it with the installer.
 *
 * Called automatically via the root "build:worker" npm script. Runs before
 * "tauri build" via the chained "build" script.
 *
 * Steps:
 *   1. cd into worker/
 *   2. Run `npm install` if node_modules is missing (idempotent otherwise)
 *   3. Run `npm run build` (invokes esbuild → worker/dist/worker.js)
 *   4. Copy worker/dist/worker.js → src-tauri/resources/worker.js
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const rootDir = resolve(here, "..");
const workerDir = resolve(rootDir, "worker");
const workerBundle = resolve(workerDir, "dist", "worker.js");
const resourcesDir = resolve(rootDir, "src-tauri", "resources");
const resourceDest = resolve(resourcesDir, "worker.js");

function log(msg) {
  console.log(`[build-worker] ${msg}`);
}

function run(cmd, cwd) {
  log(`$ ${cmd}  (in ${cwd})`);
  execSync(cmd, { cwd, stdio: "inherit" });
}

// Ensure worker dependencies are installed
if (!existsSync(resolve(workerDir, "node_modules"))) {
  log("node_modules missing in worker/ — installing");
  run("npm install", workerDir);
}

// Build the worker bundle
run("npm run build", workerDir);

if (!existsSync(workerBundle)) {
  console.error(
    `[build-worker] FAIL: esbuild did not produce ${workerBundle}`
  );
  process.exit(1);
}

// Ensure destination directory exists
if (!existsSync(resourcesDir)) {
  mkdirSync(resourcesDir, { recursive: true });
}

// Copy the bundled output to where Tauri expects it
copyFileSync(workerBundle, resourceDest);
log(`✓ Copied bundled worker → ${resourceDest}`);
