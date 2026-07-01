/**
 * Org Security & SSO settings section (Round-5 Sett-A decomposition).
 *
 * Lifted verbatim from the former `Settings.tsx` `OrgSecuritySection`. A read-only
 * posture summary, then the admin token/session policy + OIDC providers (rendered by
 * the embedded `SecuritySsoInner`), controlled by Settings' single save. The
 * SELF-SERVICE MFA lives separately under My account › Security & two-factor.
 */

import type { ConfiguredStatus } from '@/lib/types';

import { HelpTip } from '@/soc/components/HelpTip';
import { useAuth } from '@/soc/auth';
import { SecuritySsoInner } from '@/soc/pages/Security';

import { SectionTitle, SubHeader, PostureTile, type SecProps } from './primitives';

export function OrgSecuritySection({
  prefs,
  update,
  configured,
}: SecProps & { configured: ConfiguredStatus }) {
  const { authEnabled, rbacEnabled, role } = useAuth();
  const sso = (prefs.sso as { enabled?: boolean; providers?: unknown[] } | undefined) ?? {};
  const providerCount = Array.isArray(sso.providers) ? sso.providers.length : 0;

  return (
    <div className="space-y-8">
      <SectionTitle
        title="Security & single sign-on"
        sub="Authentication posture, single sign-on (OIDC) providers, and the token / session policy."
      />

      <div className="space-y-4">
        <SubHeader title="Posture">
          <HelpTip text="A read-only summary of the live auth/RBAC posture, reported by the backend." />
        </SubHeader>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <PostureTile label="Authentication" on={authEnabled} onText="Enforced" offText="Disabled" />
          <PostureTile label="RBAC" on={rbacEnabled} onText="Enforced" offText="Allow-all" />
          <PostureTile label="Single sign-on" on={Boolean(sso.enabled)} onText={`${providerCount} provider${providerCount === 1 ? '' : 's'}`} offText="Off" />
        </div>
        {role ? (
          <p className="text-xs text-muted-foreground">
            You are signed in as <span className="font-medium text-foreground">{String(role)}</span>.
          </p>
        ) : null}
      </div>

      {/* Token/session policy + OIDC providers — controlled by the Settings save. */}
      <SecuritySsoInner prefs={prefs} update={update} configured={configured} />
    </div>
  );
}
