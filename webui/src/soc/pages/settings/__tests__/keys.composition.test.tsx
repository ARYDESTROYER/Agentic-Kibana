import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

import type { ConfiguredStatus } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { KeysSection } from '../keys';

describe('KeysSection composition', () => {
  it('groups write-only credentials under the one Settings-wide save contract', () => {
    const { container } = render(
      <TooltipProvider>
        <KeysSection
          configured={{ openai_api_key: true } as ConfiguredStatus}
          draft={{ openai_api_key: 'replacement' }}
          setDraft={vi.fn()}
          saving={false}
          readOnly={false}
        />
      </TooltipProvider>,
    );

    expect(container.querySelectorAll('fieldset')).toHaveLength(3);
    expect(screen.getByText('Data access')).toBeInTheDocument();
    expect(screen.getByText('AI runtime')).toBeInTheDocument();
    expect(screen.getByText('Threat intelligence')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Update keys' })).not.toBeInTheDocument();
    expect(screen.getByText(/Settings Save changes and Discard actions/i)).toBeInTheDocument();
  });

  it('disables write-only inputs while the Settings save is in flight', () => {
    render(
      <TooltipProvider>
        <KeysSection
          configured={{} as ConfiguredStatus}
          draft={{}}
          setDraft={vi.fn()}
          saving
          readOnly={false}
        />
      </TooltipProvider>,
    );

    expect(screen.getByLabelText('OpenAI API key')).toBeDisabled();
  });
});
