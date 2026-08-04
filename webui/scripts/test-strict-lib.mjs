/**
 * Pure helpers for the release-only Console test output contract.
 *
 * Vitest writes captured `console.log` output as a line beginning `stdout |`.
 * Warnings and errors reach stderr.  Keeping this parser separate makes the
 * fail-closed behavior testable without intentionally polluting the product suite.
 */

const ANSI_ESCAPE_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;

export function hasVitestCapturedStdout(output) {
  const plain = String(output).replace(ANSI_ESCAPE_PATTERN, "");
  return plain.split(/\r\n|\n|\r/).some((line) => /^\s*stdout\s*\|/.test(line));
}

export function evaluateVitestRun({ exitCode, stdout, stderrBytes }) {
  const failures = [];

  if (exitCode !== 0) failures.push("vitest-failed");
  if (stderrBytes > 0) failures.push("stderr-output");
  if (hasVitestCapturedStdout(stdout)) failures.push("captured-console-stdout");

  return {
    ok: failures.length === 0,
    failures,
  };
}
