/** Build-time identity and aliases for the same-origin Help Center artifact. */
import packageJson from './package.json';

export interface BundledDocumentationIdentity {
  productVersion: string;
  documentationVersion: string;
  canonicalPath: string;
  aliases: readonly string[];
}

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

export function resolveBundledDocumentationIdentity(
  version: string = packageJson.version,
): BundledDocumentationIdentity {
  const match = SEMVER.exec(version.trim());
  if (!match) throw new Error(`Invalid TLSOC product version for documentation: ${version}`);
  const documentationVersion = `${match[1]}.${match[2]}`;
  return {
    productVersion: version.trim(),
    documentationVersion,
    canonicalPath: `/docs/${documentationVersion}/`,
    aliases: ['/docs/', '/docs/installed/'],
  };
}

export function resolveDocumentationAlias(
  pathname: string,
  identity: BundledDocumentationIdentity,
): string | undefined {
  const normalized = pathname.endsWith('/') ? pathname : `${pathname}/`;
  if (normalized === '/docs/' || normalized === '/docs/installed/') {
    return identity.canonicalPath;
  }
  return undefined;
}

export function resolveDocumentationDirectory(
  pathname: string,
): { kind: 'redirect' | 'rewrite'; path: string } {
  if (!pathname.endsWith('/')) return { kind: 'redirect', path: `${pathname}/` };
  return { kind: 'rewrite', path: `${pathname}index.html` };
}

export const BUNDLED_DOCUMENTATION = resolveBundledDocumentationIdentity();
