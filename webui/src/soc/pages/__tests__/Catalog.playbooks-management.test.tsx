/** Playbooks Catalog management workflow: protected browse + operator create/edit. */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

const mocks = vi.hoisted(() => ({
  getPlaybooks: vi.fn(),
  getPlaybook: vi.fn(),
  createPlaybook: vi.fn(),
  updatePlaybook: vi.fn(),
  getSettings: vi.fn(),
  canManage: true,
  toastSuccess: vi.fn(),
  toastError: vi.fn(),
}));

vi.mock('@/lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/api')>();
  return {
    ...actual,
    api: {
      ...actual.api,
      getPlaybooks: mocks.getPlaybooks,
      getPlaybook: mocks.getPlaybook,
      createPlaybook: mocks.createPlaybook,
      updatePlaybook: mocks.updatePlaybook,
      getSettings: mocks.getSettings,
    },
  };
});

vi.mock('@/soc/components/Can', () => ({
  useCan: () => mocks.canManage,
}));

vi.mock('sonner', () => ({
  toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

import type { Playbook, PlaybookDetail } from '@/lib/types';
import { TooltipProvider } from '@/ui/tooltip';
import { PlaybooksCatalog } from '../Catalog';

function playbook(over: Partial<Playbook> = {}): Playbook {
  return {
    id: 'operator_response',
    name: 'Operator response',
    version: 1,
    description: 'Operator-authored procedure.',
    priority: 20,
    match: {
      rule_ids: ['operator_rule'],
      entity_types: ['ip'],
      mitre: [],
      min_event_count: 1,
      any_tags: [],
    },
    suggested_tools: ['es_query'],
    rag_queries: [],
    escalate_if: 'Evidence confirms compromise.',
    suggested_verdict_bias: 'Recommendation only.',
    source_type: 'operator',
    protected: false,
    editable: true,
    file_name: 'operator_response.md',
    ...over,
  };
}

function detail(row: Playbook, content?: string): PlaybookDetail {
  return {
    ...row,
    content:
      content ??
      `---\nid: ${row.id}\nname: ${row.name}\nversion: ${row.version}\n---\n## Procedure\nReview.\n`,
    body: '## Procedure\nReview.\n',
  };
}

function renderCatalog() {
  return render(
    <TooltipProvider>
      <PlaybooksCatalog />
    </TooltipProvider>,
  );
}

describe('Playbooks Catalog management', () => {
  beforeEach(() => {
    mocks.getPlaybooks.mockReset();
    mocks.getPlaybook.mockReset();
    mocks.createPlaybook.mockReset();
    mocks.updatePlaybook.mockReset();
    mocks.getSettings.mockReset();
    mocks.toastSuccess.mockReset();
    mocks.toastError.mockReset();
    mocks.canManage = true;
    mocks.getSettings.mockResolvedValue({ prefs: { threshold_automation: { rules: [] } } });
  });

  it('opens bundled Markdown but never offers an edit action', async () => {
    const bundled = playbook({
      id: 'brute_force_login',
      name: 'Brute-force login',
      source_type: 'bundled',
      protected: true,
      editable: false,
      file_name: 'brute_force_login.md',
    });
    mocks.getPlaybooks.mockResolvedValue({ enabled: true, count: 1, playbooks: [bundled] });
    mocks.getPlaybook.mockResolvedValue(detail(bundled));

    renderCatalog();
    expect(await screen.findByText('Brute-force login')).toBeInTheDocument();
    expect(screen.getByText('Bundled')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /open source/i }));

    expect(await screen.findByText('Bundled · protected')).toBeInTheDocument();
    expect(screen.getByText(/id: brute_force_login/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
  });

  it('edits an operator-owned document and reloads its opened source', async () => {
    const row = playbook();
    const first = detail(row);
    const second = detail({ ...row, version: 2 }, first.content.replace('version: 1', 'version: 2'));
    mocks.getPlaybooks.mockResolvedValue({ enabled: true, count: 1, playbooks: [row] });
    mocks.getPlaybook.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    mocks.updatePlaybook.mockResolvedValue({
      ok: true,
      playbook: { ...row, version: 2 },
      reload: { loaded: 1, skipped: [], ids: [row.id] },
    });

    renderCatalog();
    fireEvent.click(await screen.findByRole('button', { name: /open source/i }));
    fireEvent.click(await screen.findByRole('button', { name: /^edit$/i }));
    const editor = screen.getByLabelText(/playbook markdown/i);
    fireEvent.change(editor, { target: { value: second.content } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    await waitFor(() => expect(mocks.updatePlaybook).toHaveBeenCalledWith(row.id, second.content));
    await waitFor(() => expect(mocks.getPlaybook).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/version: 2/)).toBeInTheDocument();
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Playbook updated and loaded.');
  });

  it('creates a new slug-bound Markdown document from the empty state', async () => {
    const row = playbook({ id: 'credential_response', name: 'New response playbook' });
    const opened = detail(row);
    mocks.getPlaybooks.mockResolvedValue({ enabled: true, count: 0, playbooks: [] });
    mocks.createPlaybook.mockResolvedValue({
      ok: true,
      playbook: row,
      reload: { loaded: 1, skipped: [], ids: [row.id] },
    });
    mocks.getPlaybook.mockResolvedValue(opened);

    renderCatalog();
    fireEvent.click(await screen.findByRole('button', { name: /new playbook/i }));
    fireEvent.change(screen.getByLabelText(/playbook id/i), {
      target: { value: 'credential_response' },
    });
    const editor = screen.getByLabelText(/playbook markdown/i) as HTMLTextAreaElement;
    expect(editor.value).toContain('id: credential_response');
    fireEvent.click(screen.getByRole('button', { name: /create playbook/i }));

    await waitFor(() => expect(mocks.createPlaybook).toHaveBeenCalledTimes(1));
    expect(mocks.createPlaybook).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'credential_response',
        content: expect.stringContaining('id: credential_response'),
      }),
    );
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Playbook created and loaded.');
  });

  it('keeps a successful create authoritative when the follow-up source read fails', async () => {
    const row = playbook({ id: 'saved_response', name: 'Saved response' });
    mocks.getPlaybooks.mockResolvedValue({ enabled: true, count: 0, playbooks: [] });
    mocks.createPlaybook.mockResolvedValue({
      ok: true,
      playbook: row,
      reload: { loaded: 1, skipped: [], ids: [row.id] },
    });
    mocks.getPlaybook.mockRejectedValue(new Error('temporary read failure'));

    renderCatalog();
    fireEvent.click(await screen.findByRole('button', { name: /new playbook/i }));
    fireEvent.change(screen.getByLabelText(/playbook id/i), {
      target: { value: 'saved_response' },
    });
    fireEvent.click(screen.getByRole('button', { name: /create playbook/i }));

    await waitFor(() => expect(mocks.createPlaybook).toHaveBeenCalledTimes(1));
    expect(mocks.toastSuccess).toHaveBeenCalledWith('Playbook created and loaded.');
    expect(await screen.findByText(/playbook saved, but could not be reopened/i)).toBeInTheDocument();
    expect(mocks.toastError).toHaveBeenCalledWith(
      expect.stringContaining('Playbook saved, but could not be reopened.'),
    );
  });

  it('keeps management controls hidden without playbooks:manage', async () => {
    mocks.canManage = false;
    const row = playbook();
    mocks.getPlaybooks.mockResolvedValue({ enabled: true, count: 1, playbooks: [row] });
    mocks.getPlaybook.mockResolvedValue(detail(row));

    renderCatalog();
    expect(await screen.findByText('Operator response')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /new playbook/i })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /open source/i }));
    expect(await screen.findByText('Operator owned')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^edit$/i })).not.toBeInTheDocument();
  });
});
