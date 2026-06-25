/**
 * Semantic status/verdict/risk pills for the shadcn-based pages (Overview +
 * Cases). They reuse the SAME colour functions as the EUI badges
 * (`riskHex`/`verdictHex`/`statusHex`) so a colour means the same thing across
 * the EUI and shadcn surfaces. Rendered as soft tinted chips (tinted fill +
 * coloured text), themed via inline style because the hexes are dynamic.
 */
import React from 'react';
import { Tooltip, TooltipContent, TooltipTrigger } from '../ui/tooltip';
import { DASH, fmtPercent, humanizeToken } from '../../lib/format';
import { riskHex, statusHex, tint, verdictHex } from '../../lib/theme';

const Pill: React.FC<{ color: string; children: React.ReactNode; dot?: boolean }> = ({ color, children, dot }) => (
  <span
    className="inline-flex items-center gap-1.5 rounded-md border px-2 h-[22px] text-xs font-semibold leading-none whitespace-nowrap"
    style={{ background: tint(color, 0.14), color, borderColor: tint(color, 0.28) }}
  >
    {dot ? <span style={{ width: 7, height: 7, borderRadius: '50%', background: color, flex: 'none' }} /> : null}
    {children}
  </span>
);

const WithTip: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <Tooltip>
    <TooltipTrigger asChild>
      <span>{children}</span>
    </TooltipTrigger>
    <TooltipContent>{title}</TooltipContent>
  </Tooltip>
);

export const RiskPill: React.FC<{ score?: number }> = ({ score }) => {
  if (typeof score !== 'number' || Number.isNaN(score)) return <Pill color="#98A2B3">Risk {DASH}</Pill>;
  return (
    <WithTip title={`Normalised risk score (0–100): ${score}`}>
      <Pill color={riskHex(score)}>Risk {Math.round(score)}</Pill>
    </WithTip>
  );
};

export const VerdictPill: React.FC<{ verdict?: string }> = ({ verdict }) => {
  if (!verdict) return <Pill color="#98A2B3" dot>Unverdicted</Pill>;
  return <Pill color={verdictHex(verdict)}>{humanizeToken(verdict)}</Pill>;
};

export const StatusPill: React.FC<{ status?: string }> = ({ status }) => (
  <Pill color={statusHex(status)} dot>
    {humanizeToken(status)}
  </Pill>
);

export const ConfidencePill: React.FC<{ confidence?: number }> = ({ confidence }) => {
  if (typeof confidence !== 'number' || Number.isNaN(confidence)) return null;
  return (
    <WithTip title="Agent confidence in the verdict">
      <Pill color="#69707D">{fmtPercent(confidence)} conf</Pill>
    </WithTip>
  );
};
