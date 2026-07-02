/**
 * `ChartCard` scrollBody opt-in (Round-6 dashboards integration).
 *
 * Tall dashboard widgets (a long table / MITRE heatmap) sit in a FIXED-height grid cell
 * whose outer card is `overflow-hidden`. Without an internal scroll region the body was
 * CLIPPED (cut off). `scrollBody` makes the card a `min-h-0` flex column and the content
 * area `min-h-0 flex-1 overflow-auto`, so the body scrolls inside the cell instead of
 * being cut off. It is OFF by default → byte-identical for the Metrics page.
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Crosshair } from 'lucide-react';

import { ChartCard } from '@/soc/components/ChartCard';

describe('ChartCard — scrollBody', () => {
  it('adds an internal scroll region to the content when scrollBody is set', () => {
    const { getByText } = render(
      <ChartCard title="Coverage" icon={Crosshair} scrollBody>
        <div>body</div>
      </ChartCard>,
    );
    // The direct parent of the body is the CardContent — it gains overflow-auto + min-h-0.
    const content = getByText('body').parentElement as HTMLElement;
    expect(content.className).toContain('overflow-auto');
    expect(content.className).toContain('min-h-0');
  });

  it('does NOT add an internal scroll region by default (Metrics parity)', () => {
    const { getByText } = render(
      <ChartCard title="Coverage" icon={Crosshair}>
        <div>body</div>
      </ChartCard>,
    );
    const content = getByText('body').parentElement as HTMLElement;
    expect(content.className).not.toContain('overflow-auto');
  });
});
