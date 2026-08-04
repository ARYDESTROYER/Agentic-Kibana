import assert from "node:assert/strict";
import test from "node:test";

import { evaluateVitestRun, hasVitestCapturedStdout } from "./test-strict-lib.mjs";

test("accepts a successful quiet Vitest run", () => {
  assert.deepEqual(
    evaluateVitestRun({
      exitCode: 0,
      stdout: " Test Files  285 passed (285)\n Tests  1928 passed (1928)\n",
      stderrBytes: 0,
    }),
    { ok: true, failures: [] },
  );
});

test("rejects any stderr byte even when Vitest succeeds", () => {
  assert.deepEqual(
    evaluateVitestRun({ exitCode: 0, stdout: "", stderrBytes: 1 }),
    { ok: false, failures: ["stderr-output"] },
  );
});

test("detects Vitest captured console stdout blocks", () => {
  assert.equal(
    hasVitestCapturedStdout("stdout | src/example.test.tsx > renders\nfixture output\n"),
    true,
  );
  assert.equal(
    hasVitestCapturedStdout("\u001b[32mstdout\u001b[0m | src/example.test.tsx > renders\n"),
    true,
  );
});

test("does not mistake ordinary test text for a captured stdout header", () => {
  assert.equal(hasVitestCapturedStdout("assertion mentions stdout | as ordinary text\n"), false);
});

test("reports the process failure and every output-contract failure together", () => {
  assert.deepEqual(
    evaluateVitestRun({
      exitCode: 1,
      stdout: "stdout | src/example.test.tsx > renders\nfixture output\n",
      stderrBytes: 8,
    }),
    {
      ok: false,
      failures: ["vitest-failed", "stderr-output", "captured-console-stdout"],
    },
  );
});
