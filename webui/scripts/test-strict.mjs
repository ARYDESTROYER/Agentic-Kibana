#!/usr/bin/env node

/**
 * Release-only Vitest runner.
 *
 * The regular `npm test` command intentionally stays direct and argument-friendly
 * for focused development. CI and release acceptance use this wrapper so a green
 * suite cannot silently reintroduce React/Radix/Recharts warnings or console logs.
 */

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { evaluateVitestRun } from "./test-strict-lib.mjs";

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const webuiDirectory = path.dirname(scriptsDirectory);
const vitestEntry = path.join(webuiDirectory, "node_modules", "vitest", "vitest.mjs");
const stdoutChunks = [];
let stderrBytes = 0;

const child = spawn(process.execPath, [vitestEntry, "run", ...process.argv.slice(2)], {
  cwd: webuiDirectory,
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  stdoutChunks.push(chunk);
  process.stdout.write(chunk);
});

child.stderr.on("data", (chunk) => {
  stderrBytes += chunk.byteLength;
  process.stderr.write(chunk);
});

const forwardSigint = () => {
  if (!child.killed) child.kill("SIGINT");
};
const forwardSigterm = () => {
  if (!child.killed) child.kill("SIGTERM");
};

process.once("SIGINT", forwardSigint);
process.once("SIGTERM", forwardSigterm);

let result;
try {
  result = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve({ exitCode, signal }));
  });
} catch (error) {
  console.error(`Unable to start Vitest: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}

process.removeListener("SIGINT", forwardSigint);
process.removeListener("SIGTERM", forwardSigterm);

if (result?.signal) {
  console.error(`Vitest was terminated by ${result.signal}.`);
  process.exitCode = 1;
} else if (result) {
  const evaluation = evaluateVitestRun({
    exitCode: result.exitCode,
    stdout: Buffer.concat(stdoutChunks).toString("utf8"),
    stderrBytes,
  });

  if (!evaluation.ok) {
    if (result.exitCode === 0) {
      console.error(
        `Strict Console test gate failed: ${evaluation.failures.join(", ")}. ` +
          "Fix output at its owning test or component; do not suppress it globally.",
      );
    }
    process.exitCode = result.exitCode || 1;
  }
}
