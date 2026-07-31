import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';

import type { ConfiguredStatus } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { KeysSection } from '../keys';

describe('KeysSection composition', () => {
  it('groups write-only credentials by operator job without changing the save contract', () => {
    const onSave = vi.fn();
    const { container } = render(
      <TooltipProvider>
        <KeysSection
          configured={{ openai_api_key: true } as ConfiguredStatus}
          draft={{ openai_api_key: 'replacement' }}
          setDraft={vi.fn()}
          onSave={onSave}
          saving={false}
          readOnly={false}
        />
      </TooltipProvider>,
    );

    expect(container.querySelectorAll('fieldset')).toHaveLength(3);
    expect(screen.getByText('Data access')).toBeInTheDocument();
    expect(screen.getByText('AI runtime')).toBeInTheDocument();
    expect(screen.getByText('Threat intelligence')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Update keys' }));
    expect(onSave).toHaveBeenCalledTimes(1);
  });
});
