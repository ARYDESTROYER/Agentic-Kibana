import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  RUNBOOK_BODY_MAX_CHARS,
  RUNBOOK_DESCRIPTOR_MAX_CHARS,
  validateRunbookAuthoring,
} from '../runbookAuthoring';
import { RUNBOOK_EXAMPLES } from '../runbookExamples';

describe('downloadable Runbook examples', () => {
  it('publishes deterministic, unique, strictly compliant Markdown assets', () => {
    expect(RUNBOOK_EXAMPLES).toHaveLength(3);
    expect(new Set(RUNBOOK_EXAMPLES.map((example) => example.id)).size).toBe(
      RUNBOOK_EXAMPLES.length,
    );
    expect(new Set(RUNBOOK_EXAMPLES.map((example) => example.filename)).size).toBe(
      RUNBOOK_EXAMPLES.length,
    );

    for (const example of RUNBOOK_EXAMPLES) {
      expect(example.href).toBe(`/examples/runbooks/${example.filename}`);
      const assetPath = resolve(process.cwd(), 'public', example.href.replace(/^\//, ''));
      const content = readFileSync(assetPath, 'utf8');
      const result = validateRunbookAuthoring(content, example.id);

      expect(result.issues, `${example.filename} must match the strict authoring policy`).toEqual([]);
      expect(result.bodyCharacters).toBeLessThanOrEqual(RUNBOOK_BODY_MAX_CHARS);
      expect(result.descriptorCharacters).toBeLessThanOrEqual(
        RUNBOOK_DESCRIPTOR_MAX_CHARS,
      );
      expect(content).toContain(`id: ${example.id}`);
      expect(content.endsWith('\n')).toBe(true);
    }
  });
});
