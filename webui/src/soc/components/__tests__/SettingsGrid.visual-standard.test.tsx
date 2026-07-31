import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Settings, SlidersHorizontal } from 'lucide-react';

import {
  SettingsCard,
  SettingsGrid,
  SettingsTOC,
  StickySaveBar,
} from '@/soc/components/SettingsGrid';
import { Button } from '@/ui/button';

const noop = () => {};

describe('Settings composition visual standard', () => {
  it('renders settings as flat, labelled divider-led sections', () => {
    const { container } = render(
      <SettingsGrid>
        <SettingsCard
          anchor="operator-policy"
          title="Operator policy"
          description="Controls the analyst workflow."
          icon={Settings}
          actions={<Button size="sm">Review</Button>}
        >
          <p>Policy controls</p>
        </SettingsCard>
      </SettingsGrid>,
    );

    const grid = container.firstElementChild as HTMLElement;
    expect(grid.className).toContain('gap-x-10');

    const section = screen.getByRole('region', { name: 'Operator policy' });
    expect(section.className).toContain('border-t');
    expect(section.className).toContain('bg-transparent');
    expect(section.className).not.toMatch(/rounded|shadow|bg-card/);
    expect(section.className).not.toContain('overflow-hidden');

    const heading = screen.getByRole('heading', { name: 'Operator policy', level: 3 });
    expect(heading).toHaveAttribute('id', 'operator-policy-title');
    expect(heading.className).toContain('text-base');
    expect(screen.getByText('Controls the analyst workflow.').className).toContain('text-sm');
  });

  it('keeps save and discard in one flat sticky action band', () => {
    const { rerender } = render(
      <StickySaveBar
        visible
        onSave={noop}
        onDiscard={noop}
        message="2 unsaved changes"
      />,
    );

    const bar = screen.getByRole('region', { name: 'Unsaved changes' });
    expect(bar.className).toContain('border-y');
    expect(bar.className).toContain('bg-background');
    expect(bar.className).not.toMatch(/rounded|shadow|backdrop|animate-rise/);
    expect(screen.getByRole('button', { name: 'Discard' }).className).toContain('border-input');

    rerender(
      <StickySaveBar visible busy onSave={noop} onDiscard={noop} message="Saving changes" />,
    );
    expect(screen.getByRole('region', { name: 'Unsaved changes' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Saving…' }).querySelector('[data-loading-motion="indeterminate-ring"]')).toBeInTheDocument();
  });

  it('uses squared, orientation-aware in-section navigation', () => {
    const onSelect = vi.fn();
    render(
      <SettingsTOC
        items={[
          { anchor: 'controls', label: 'Controls', icon: SlidersHorizontal },
          { anchor: 'review', label: 'Review' },
        ]}
        active="controls"
        orientation="horizontal"
        onSelect={onSelect}
      />,
    );

    const nav = screen.getByRole('navigation', { name: 'Settings sections' });
    // `aria-orientation` is not supported on a plain navigation landmark. The
    // orientation is visual only; every entry remains an ordinary tabbable button.
    expect(nav).not.toHaveAttribute('aria-orientation');
    const active = screen.getByRole('button', { name: 'Controls' });
    expect(active.className).toContain('border-b-2');
    expect(active.className).not.toContain('rounded');
  });
});
