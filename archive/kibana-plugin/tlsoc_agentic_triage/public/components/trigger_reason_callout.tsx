import React from 'react';
import { EuiCallOut, EuiText } from '@elastic/eui';
import type { TriggerReason } from '../../common';

interface Props {
  triggerReason?: TriggerReason | null;
  /** Smaller variant for inline/table contexts. */
  size?: 's' | 'm';
}

/**
 * Feature 3 — renders the deterministic "why was this triggered" explanation.
 * Omits gracefully when there is no trigger reason (or no usable content).
 */
export const TriggerReasonCallout: React.FC<Props> = ({ triggerReason, size = 's' }) => {
  const tr = triggerReason;
  if (!tr) {
    return null;
  }

  const sentence = (tr.sentence || '').trim();
  const hasObserved = typeof tr.observed_count === 'number' && tr.observed_count > 0;
  const hasWindow = typeof tr.window_seconds === 'number' && tr.window_seconds > 0;

  // Nothing meaningful to show.
  if (!sentence && !hasObserved && !hasWindow) {
    return null;
  }

  const detailBits: string[] = [];
  if (hasObserved) {
    detailBits.push(`observed ${tr.observed_count}`);
  }
  if (hasWindow) {
    detailBits.push(`within ${tr.window_seconds}s window`);
  }
  if (tr.mode) {
    detailBits.push(`mode: ${tr.mode}`);
  }

  return (
    <EuiCallOut title="Why this fired" color="primary" iconType="iInCircle" size={size}>
      <EuiText size="s">
        {sentence ? <p>{sentence}</p> : null}
        {detailBits.length ? (
          <p>
            <small>{detailBits.join(' · ')}</small>
          </p>
        ) : null}
      </EuiText>
    </EuiCallOut>
  );
};
