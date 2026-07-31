/**
 * Pervasive customization (Round-2 Wave 7) — frontend render/behaviour tests.
 *
 * Covers:
 *  1. PrefsContext + SavedViewsBar: a mocked api hydrates the effective cascade;
 *     creating a view calls api.views.create and the new view appears in the bar;
 *     applying it calls the page's onApply with the stored config.
 *  2. DataTable column customization: a ColumnState hides + reorders columns; the
 *     ColumnsMenu emits a new state on toggle (persisted via PrefsContext).
 *  3. Theme toggle: setThemeMode persists to api.prefs.putUser and drives the theme.
 *
 * The api client is mocked so no network is hit; the cascade + mutators are exercised
 * end-to-end through the real PrefsProvider.
 */
import * as React from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// ---- Mock the typed api client BEFORE importing anything that pulls it in. ---- //
const created = { id: 'view-new', name: 'My view', scope: 'cases', shared: false, filters: { status: 'open' }, sort: '-updated_at', columns: null };
const mocks = {
  effective: vi.fn(),
  putUser: vi.fn().mockResolvedValue({}),
  tablesPut: vi.fn().mockResolvedValue({ table_id: 'cases', state: {} }),
  viewsCreate: vi.fn().mockResolvedValue(created),
  viewsClone: vi.fn(),
  viewsRemove: vi.fn().mockResolvedValue({ ok: true, id: 'x' }),
  getOrg: vi.fn().mockResolvedValue({ terminology: {}, default_theme: 'system' }),
  getBranding: vi.fn().mockResolvedValue({}),
  authMe: vi.fn().mockResolvedValue({ auth_enabled: false, authenticated: true, user: null }),
};

vi.mock('@/lib/api', () => {
  class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
      this.name = 'ApiError';
    }
  }
  return {
    ApiError,
    setUnauthorizedHandler: vi.fn(),
    setReauthHandler: vi.fn(),
    api: {
      prefs: {
        effective: () => mocks.effective(),
        getUser: vi.fn(),
        putUser: (p: unknown) => mocks.putUser(p),
        getOrg: () => mocks.getOrg(),
        putOrg: vi.fn(),
        tables: { put: (id: string, s: unknown) => mocks.tablesPut(id, s) },
      },
      views: {
        list: vi.fn(),
        create: (v: unknown) => mocks.viewsCreate(v),
        update: vi.fn(),
        remove: (id: string) => mocks.viewsRemove(id),
        clone: (id: string) => mocks.viewsClone(id),
      },
      terminology: { get: vi.fn(), put: vi.fn() },
      getBranding: () => mocks.getBranding(),
      auth: { me: () => mocks.authMe() },
      roles: { get: vi.fn().mockResolvedValue({ matrix: {}, rbac_enabled: false }) },
    },
  };
});

import { ThemeProvider } from '../theme';
import { AuthProvider } from '../auth';
import { PrefsProvider, usePrefs } from '../prefs';
import { SavedViewsBar } from '../components/SavedViewsBar';
import { ColumnsMenu } from '../components/ColumnsMenu';
import { DataTable, type DataTableColumn, type ColumnState } from '../components/DataTable';
import type { EffectivePrefs, SavedView } from '@/lib/types';

const EMPTY_EFFECTIVE: EffectivePrefs = {
  terminology: {},
  theme_mode: 'system',
  saved_views: [],
  pinned_view_ids: [],
  tables: {},
  last_list_state: {},
  misc: {},
  org: { terminology: {}, default_theme: 'system', default_saved_views: [], default_pinned_view_ids: [] },
};

function Providers({ children }: { children: React.ReactNode }) {
  return (
    <ThemeProvider>
      <AuthProvider>
        <PrefsProvider>{children}</PrefsProvider>
      </AuthProvider>
    </ThemeProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.effective.mockResolvedValue({ ...EMPTY_EFFECTIVE });
  mocks.viewsCreate.mockResolvedValue(created);
  document.documentElement.classList.remove('dark');
  window.localStorage.clear();
});

// --------------------------------------------------------------------------- //
// 1. PrefsContext + SavedViewsBar — create + apply a view
// --------------------------------------------------------------------------- //
describe('SavedViewsBar', () => {
  it('hydrates the cascade and saves a view via api.views.create', async () => {
    const applied: Array<SavedView | null> = [];
    render(
      <Providers>
        <SavedViewsBar
          scope="cases"
          activeViewId={null}
          onApply={(v) => applied.push(v)}
          getCurrent={() => ({ filters: { status: 'open' }, sort: '-updated_at', columns: null })}
        />
      </Providers>,
    );

    // The bar renders with the default "All cases" switcher label.
    expect(await screen.findByLabelText('Saved views')).toBeInTheDocument();

    // Open the "Save view" popover, type a name, save.
    fireEvent.click(screen.getByRole('button', { name: /save view/i }));
    const input = await screen.findByLabelText('View name');
    fireEvent.change(input, { target: { value: 'My view' } });
    // The Save button inside the popover.
    const saveBtns = screen.getAllByRole('button', { name: /save view/i });
    fireEvent.click(saveBtns[saveBtns.length - 1]);

    await waitFor(() => expect(mocks.viewsCreate).toHaveBeenCalledTimes(1));
    expect(mocks.viewsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'My view', scope: 'cases', filters: { status: 'open' } }),
    );
    // Saving auto-applies the created view back to the page.
    await waitFor(() => expect(applied.some((v) => v?.id === 'view-new')).toBe(true));
  });

  it('lists an org-shared view from the hydrated cascade', async () => {
    mocks.effective.mockResolvedValue({
      ...EMPTY_EFFECTIVE,
      saved_views: [{ id: 'view-org', name: 'Org triage', scope: 'cases', shared: true }],
    });
    render(
      <Providers>
        <SavedViewsBar scope="cases" activeViewId={null} onApply={() => {}} getCurrent={() => ({ filters: {}, sort: '', columns: null })} />
      </Providers>,
    );
    // Wait for the cascade to hydrate (the mocked effective resolves the org view).
    await waitFor(() => expect(mocks.effective).toHaveBeenCalled());
    // Open the switcher and assert the org view is listed.
    await userEvent.click(await screen.findByLabelText('Saved views'));
    expect((await screen.findAllByText('Org triage')).length).toBeGreaterThan(0);
  });
});

// --------------------------------------------------------------------------- //
// 2. Column customization — DataTable applies state; ColumnsMenu emits changes
// --------------------------------------------------------------------------- //
interface Row {
  id: string;
  name: string;
}
const COLUMNS: DataTableColumn<Row>[] = [
  { id: 'id', header: 'ID', cell: (r) => r.id, lockVisible: true },
  { id: 'name', header: 'Name', cell: (r) => r.name },
  { id: 'risk', header: 'Risk', cell: () => '—' },
];
const ROWS: Row[] = [{ id: 'c1', name: 'Alpha' }];

describe('DataTable column customization', () => {
  it('hides a column named in ColumnState.hidden', () => {
    const { rerender } = render(
      <DataTable<Row> columns={COLUMNS} rows={ROWS} getRowId={(r) => r.id} />,
    );
    // All three headers render by default.
    expect(screen.getByText('Risk')).toBeInTheDocument();

    rerender(
      <DataTable<Row>
        columns={COLUMNS}
        rows={ROWS}
        getRowId={(r) => r.id}
        columnState={{ hidden: ['risk'] }}
      />,
    );
    expect(screen.queryByText('Risk')).not.toBeInTheDocument();
    // The locked + remaining columns still show.
    expect(screen.getByText('ID')).toBeInTheDocument();
    expect(screen.getByText('Name')).toBeInTheDocument();
  });

  it('ColumnsMenu emits a new state hiding a toggled column', async () => {
    const onChange = vi.fn();
    const items = COLUMNS.map((c) => ({ id: c.id, label: String(c.header), lockVisible: c.lockVisible }));
    let state: ColumnState = {};
    render(<ColumnsMenu columns={items} state={state} onChange={onChange} />);
    await userEvent.click(screen.getByRole('button', { name: /customize columns/i }));
    // Toggle the (hideable) "Risk" column off.
    const toggle = await screen.findByLabelText('Toggle column Risk');
    const moveUp = screen.getByRole('button', { name: 'Move Risk up' });
    const moveDown = screen.getByRole('button', { name: 'Move Risk down' });
    expect(moveUp).toHaveClass('min-h-6', 'min-w-6');
    expect(moveDown).toHaveClass('min-h-6', 'min-w-6');
    expect(moveUp.querySelector('svg')).toHaveClass('size-3.5');
    await userEvent.click(toggle);
    expect(onChange).toHaveBeenCalledTimes(1);
    state = onChange.mock.calls[0][0] as ColumnState;
    expect(state.hidden).toContain('risk');
  });
});

// --------------------------------------------------------------------------- //
// 3. Theme toggle — setThemeMode persists to api.prefs.putUser + drives the class
// --------------------------------------------------------------------------- //
function ThemeHarness() {
  const { themeMode, setThemeMode } = usePrefs();
  return (
    <div>
      <span data-testid="mode">{themeMode}</span>
      <button type="button" onClick={() => setThemeMode('dark')}>
        go dark
      </button>
    </div>
  );
}

describe('theme mode', () => {
  it('persists the chosen mode to api.prefs.putUser and applies .dark', async () => {
    render(
      <Providers>
        <ThemeHarness />
      </Providers>,
    );
    // Hydrated to the cascade default ('system').
    await waitFor(() => expect(screen.getByTestId('mode')).toHaveTextContent('system'));

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /go dark/i }));
    });

    expect(screen.getByTestId('mode')).toHaveTextContent('dark');
    await waitFor(() =>
      expect(mocks.putUser).toHaveBeenCalledWith(expect.objectContaining({ theme_mode: 'dark' })),
    );
    expect(document.documentElement.classList.contains('dark')).toBe(true);
  });
});
