export interface RunbookExample {
  id: string;
  title: string;
  description: string;
  filename: string;
  href: string;
  coverage: readonly string[];
}

/**
 * Versioned, same-origin examples for the New Runbook sheet.
 *
 * The files are downloadable references only. They are never inserted into the
 * editor, submitted to the API, indexed, or treated as trusted knowledge unless
 * an operator deliberately reviews and creates a separate Runbook.
 */
export const RUNBOOK_EXAMPLES: readonly RunbookExample[] = [
  {
    id: 'encoded_powershell_execution',
    title: 'Encoded PowerShell execution',
    description: 'Endpoint investigation with decoding, ancestry, ownership, and falsifying evidence.',
    filename: 'encoded-powershell.md',
    href: '/examples/runbooks/encoded-powershell.md',
    coverage: ['Endpoint', 'Malware'],
  },
  {
    id: 'impossible_travel_signin',
    title: 'Impossible travel sign-in',
    description: 'Identity investigation that distinguishes account misuse from routing and travel effects.',
    filename: 'impossible-travel-signin.md',
    href: '/examples/runbooks/impossible-travel-signin.md',
    coverage: ['Identity', 'Cloud'],
  },
  {
    id: 'dns_beaconing',
    title: 'Repetitive DNS beaconing',
    description: 'Network investigation covering cadence, process attribution, and expected service behavior.',
    filename: 'dns-beaconing.md',
    href: '/examples/runbooks/dns-beaconing.md',
    coverage: ['Network', 'Command and control'],
  },
] as const;
