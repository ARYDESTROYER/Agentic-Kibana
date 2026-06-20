/**
 * Step 1 — Welcome / deployment. Name the deployment, explain the agentic SOC,
 * and offer a non-destructive "Demo mode" toggle so an operator can click through
 * with sensible defaults and no real SIEM.
 */
import React from 'react';
import {
  EuiCallOut,
  EuiFieldText,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFormRow,
  EuiIcon,
  EuiPanel,
  EuiSpacer,
  EuiSwitch,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import { COLORS } from '../../../lib/theme';
import { IconChip } from '../../common/ui';

interface WelcomeStepProps {
  deploymentName: string;
  onDeploymentName: (v: string) => void;
  demoMode: boolean;
  onDemoMode: (v: boolean) => void;
}

const FEATURES: Array<{ icon: string; title: string; body: string; accent: string }> = [
  {
    icon: 'inspect',
    title: 'Read-only triage',
    body: 'The agent reads your security events with a scoped, read-only key and never modifies your pipeline.',
    accent: COLORS.primary,
  },
  {
    icon: 'visGauge',
    title: 'Deterministic risk + LLM verdicts',
    body: 'Correlation and risk scoring are deterministic; the LLM proposes verdicts. Close/escalate decisions stay in code.',
    accent: COLORS.accent,
  },
  {
    icon: 'reportingApp',
    title: 'Audited & cost-metered',
    body: 'Every agent action is audited and every model call is metered, so you keep full provenance and a cost ledger.',
    accent: COLORS.success,
  },
];

export const WelcomeStep: React.FC<WelcomeStepProps> = ({
  deploymentName,
  onDeploymentName,
  demoMode,
  onDemoMode,
}) => (
  <div>
    <EuiTitle size="m">
      <h2>Welcome to your Agentic SOC</h2>
    </EuiTitle>
    <EuiSpacer size="s" />
    <EuiText color="subdued">
      <p>
        This console turns raw alert volume into audited, cost-metered,
        human-reviewable cases. Let&apos;s get it connected to your data and models.
      </p>
    </EuiText>

    <EuiSpacer size="l" />

    <EuiFlexGroup gutterSize="m">
      {FEATURES.map((f) => (
        <EuiFlexItem key={f.title}>
          <EuiPanel hasBorder paddingSize="m" style={{ height: '100%' }}>
            <IconChip icon={f.icon} accent={f.accent} />
            <EuiSpacer size="s" />
            <EuiTitle size="xxs">
              <h4>{f.title}</h4>
            </EuiTitle>
            <EuiText size="xs" color="subdued">
              <span>{f.body}</span>
            </EuiText>
          </EuiPanel>
        </EuiFlexItem>
      ))}
    </EuiFlexGroup>

    <EuiSpacer size="xl" />

    <EuiFormRow
      label="Deployment name"
      helpText="A label for this SOC deployment, shown across the console."
      fullWidth
    >
      <EuiFieldText
        icon="tag"
        value={deploymentName}
        onChange={(e) => onDeploymentName(e.target.value)}
        placeholder="e.g. Acme Production SOC"
        fullWidth
      />
    </EuiFormRow>

    <EuiSpacer size="m" />

    <EuiPanel color="subdued" hasShadow={false} paddingSize="m">
      <EuiFlexGroup alignItems="center" gutterSize="m" responsive={false}>
        <EuiFlexItem grow={false}>
          <EuiIcon type="beaker" color={COLORS.accent} size="l" />
        </EuiFlexItem>
        <EuiFlexItem>
          <EuiSwitch
            label="Demo mode (explore with defaults, no real SIEM required)"
            checked={demoMode}
            onChange={(e) => onDemoMode(e.target.checked)}
          />
          <EuiText size="xs" color="subdued">
            <span>
              Demo mode is non-destructive: it seeds nothing and simply lets you click
              through the wizard and console using sensible defaults. You can still add a
              real source on the next step.
            </span>
          </EuiText>
        </EuiFlexItem>
      </EuiFlexGroup>
    </EuiPanel>

    {demoMode ? (
      <>
        <EuiSpacer size="m" />
        <EuiCallOut size="s" color="primary" iconType="iInCircle" title="Demo mode is on">
          <p>
            You can finish setup without configuring a live source. The analytics surfaces
            will show empty states until a real source is connected.
          </p>
        </EuiCallOut>
      </>
    ) : null}
  </div>
);
