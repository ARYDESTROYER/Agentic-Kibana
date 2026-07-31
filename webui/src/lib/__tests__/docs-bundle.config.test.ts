import { describe, expect, it } from 'vitest';

import {
  resolveBundledDocumentationIdentity,
  resolveDocumentationAlias,
  resolveDocumentationDirectory,
} from '../../../docs.config';

describe('bundled documentation identity', () => {
  it('derives the installed documentation line from product SemVer', () => {
    expect(resolveBundledDocumentationIdentity('0.1.9')).toEqual({
      productVersion: '0.1.9',
      documentationVersion: '0.1',
      canonicalPath: '/docs/0.1/',
      aliases: ['/docs/', '/docs/installed/'],
    });
  });

  it('redirects only truthful installed aliases', () => {
    const identity = resolveBundledDocumentationIdentity('2.7.3');
    expect(resolveDocumentationAlias('/docs', identity)).toBe('/docs/2.7/');
    expect(resolveDocumentationAlias('/docs/installed/', identity)).toBe('/docs/2.7/');
    expect(resolveDocumentationAlias('/docs/latest/', identity)).toBeUndefined();
    expect(resolveDocumentationAlias('/docs/development/', identity)).toBeUndefined();
    expect(resolveDocumentationAlias('/docs/2.7/', identity)).toBeUndefined();
  });

  it('rejects invalid release versions instead of guessing a docs path', () => {
    expect(() => resolveBundledDocumentationIdentity('testing')).toThrow(/Invalid Agentic SOC/);
  });

  it('points a pretty MkDocs directory URL at its concrete static index', () => {
    expect(resolveDocumentationDirectory('/docs/0.1/analyst/case-manager')).toEqual({
      kind: 'redirect',
      path: '/docs/0.1/analyst/case-manager/',
    });
    expect(resolveDocumentationDirectory('/docs/0.1/analyst/case-manager/')).toEqual({
      kind: 'rewrite',
      path: '/docs/0.1/analyst/case-manager/index.html',
    });
  });
});
