/**
 * First-run setup wizard.
 *
 * Shown automatically when GET /api/setup/status reports `setup_complete: false`,
 * and re-runnable from Settings. A 5-step EuiSteps flow:
 *
 *   1. Welcome / deployment   — name the deployment + demo-mode toggle
 *   2. Add your first source  — pick a connector, fill its dynamic form, test, save
 *   3. LLM providers          — Anthropic/OpenAI keys + per-role model pickers
 *   4. Enrichment & detection — enrichment keys, correlation, risk weights, caps
 *   5. Review & finish        — summary → POST /api/setup/complete → dashboard
 *
 * Progress lives in component state; every key/value the backend exposes is
 * reachable here (the explicit requirement).
 */
import React, { useEffect, useState } from 'react';
import {
  EuiButton,
  EuiButtonEmpty,
  EuiFlexGroup,
  EuiFlexItem,
  EuiPage,
  EuiPageBody,
  EuiPanel,
  EuiSpacer,
  EuiStepsHorizontal,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type {
  ConnectorManifest,
  ModelsResponse,
  Preferences,
  SetupStatus,
  SourceInstance,
} from '../../lib/types';
import { api } from '../../lib/api';
import { COLORS } from '../../lib/theme';
import { ErrorCallout, IconChip, Loading } from '../common/ui';
import { WelcomeStep } from './steps/WelcomeStep';
import { SourcesStep } from './steps/SourcesStep';
import { ProvidersStep } from './steps/ProvidersStep';
import { DetectionStep } from './steps/DetectionStep';
import { ReviewStep } from './steps/ReviewStep';

interface WizardProps {
  /** Called when setup completes successfully — App routes to the dashboard. */
  onComplete: () => void;
  /** Re-run mode: render a "Close" affordance back to the app. */
  onExit?: () => void;
}

export const Wizard: React.FC<WizardProps> = ({ onComplete, onExit }) => {
  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<unknown>(null);
  const [finishing, setFinishing] = useState(false);

  // Shared, persisted-between-steps state.
  const [deploymentName, setDeploymentName] = useState('My SOC');
  const [demoMode, setDemoMode] = useState(false);

  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [connectors, setConnectors] = useState<ConnectorManifest[]>([]);
  const [sources, setSources] = useState<SourceInstance[]>([]);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [prefs, setPrefs] = useState<Preferences | null>(null);

  const refreshStatus = async () => {
    const [st, src] = await Promise.all([api.setupStatus(), api.listSources()]);
    setStatus(st);
    setSources(src.sources);
  };

  useEffect(() => {
    (async () => {
      try {
        const [st, conns, src, mdl, settings] = await Promise.all([
          api.setupStatus(),
          api.listConnectors(),
          api.listSources(),
          api.getModels().catch(() => null),
          api.getSettings(),
        ]);
        setStatus(st);
        setConnectors(conns.connectors);
        setSources(src.sources);
        setModels(mdl);
        setPrefs(settings.prefs);
      } catch (e) {
        setError(e);
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  const finish = async () => {
    setFinishing(true);
    setError(null);
    try {
      // Persist deployment-name + demo flag additively into prefs (round-trips harmlessly).
      await api.putSettings({
        deployment_name: deploymentName,
        demo_mode: demoMode,
      } as Partial<Preferences>);
      await api.completeSetup();
      onComplete();
    } catch (e) {
      setError(e);
      setFinishing(false);
    }
  };

  const steps = [
    { title: 'Welcome' },
    { title: 'Sources' },
    { title: 'LLM providers' },
    { title: 'Enrichment & detection' },
    { title: 'Review & finish' },
  ];

  const horizontalSteps = steps.map((s, i) => ({
    title: s.title,
    status: (i < step ? 'complete' : i === step ? 'current' : 'incomplete') as
      | 'complete'
      | 'current'
      | 'incomplete',
    onClick: () => setStep(i),
  }));

  const next = () => setStep((s) => Math.min(s + 1, steps.length - 1));
  const back = () => setStep((s) => Math.max(s - 1, 0));

  let body: React.ReactNode = null;
  if (loading) {
    body = <Loading label="Loading setup…" />;
  } else if (error && !status) {
    body = <ErrorCallout error={error} title="Could not load the setup wizard" />;
  } else {
    switch (step) {
      case 0:
        body = (
          <WelcomeStep
            deploymentName={deploymentName}
            onDeploymentName={setDeploymentName}
            demoMode={demoMode}
            onDemoMode={setDemoMode}
          />
        );
        break;
      case 1:
        body = (
          <SourcesStep
            connectors={connectors}
            sources={sources}
            onChanged={refreshStatus}
            demoMode={demoMode}
          />
        );
        break;
      case 2:
        body = prefs ? (
          <ProvidersStep
            models={models}
            configured={status?.configured || {}}
            prefs={prefs}
            onPrefs={setPrefs}
            onSecretsSaved={refreshStatus}
          />
        ) : null;
        break;
      case 3:
        body = prefs ? (
          <DetectionStep
            configured={status?.configured || {}}
            prefs={prefs}
            onPrefs={setPrefs}
            onSecretsSaved={refreshStatus}
          />
        ) : null;
        break;
      case 4:
        body = (
          <ReviewStep
            deploymentName={deploymentName}
            demoMode={demoMode}
            sources={sources}
            configured={status?.configured || {}}
            prefs={prefs}
          />
        );
        break;
    }
  }

  const isLast = step === steps.length - 1;

  return (
    <EuiPage paddingSize="l" restrictWidth={1100} style={{ minHeight: '100vh' }}>
      <EuiPageBody>
        <EuiFlexGroup alignItems="center" gutterSize="m" responsive={false}>
          <EuiFlexItem grow={false}>
            <IconChip icon="securityApp" accent={COLORS.primary} large />
          </EuiFlexItem>
          <EuiFlexItem>
            <EuiTitle size="l">
              <h1>Agentic SOC — first-run setup</h1>
            </EuiTitle>
            <EuiText size="s" color="subdued">
              Configure your sources, models, and detection so the agent can start triaging.
            </EuiText>
          </EuiFlexItem>
          {onExit ? (
            <EuiFlexItem grow={false}>
              <EuiButtonEmpty iconType="cross" onClick={onExit}>
                Close
              </EuiButtonEmpty>
            </EuiFlexItem>
          ) : null}
        </EuiFlexGroup>

        <EuiSpacer size="l" />
        <EuiStepsHorizontal steps={horizontalSteps} />
        <EuiSpacer size="l" />

        <EuiPanel hasBorder paddingSize="l">
          {body}
        </EuiPanel>

        {error && status ? (
          <>
            <EuiSpacer size="m" />
            <ErrorCallout error={error} title="Could not complete setup" />
          </>
        ) : null}

        <EuiSpacer size="l" />
        <EuiFlexGroup justifyContent="spaceBetween" responsive={false}>
          <EuiFlexItem grow={false}>
            <EuiButtonEmpty iconType="arrowLeft" onClick={back} isDisabled={step === 0}>
              Back
            </EuiButtonEmpty>
          </EuiFlexItem>
          <EuiFlexItem grow={false}>
            {isLast ? (
              <EuiButton fill iconType="check" onClick={finish} isLoading={finishing}>
                Finish setup
              </EuiButton>
            ) : (
              <EuiButton fill iconType="arrowRight" iconSide="right" onClick={next}>
                Continue
              </EuiButton>
            )}
          </EuiFlexItem>
        </EuiFlexGroup>
      </EuiPageBody>
    </EuiPage>
  );
};
