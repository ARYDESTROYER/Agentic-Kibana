/**
 * Users & roles — admin-only multi-user administration (Wave 1).
 *
 * A table of accounts with: add (dialog), change role (inline Select), enable/
 * disable (Switch), reset password (dialog), and delete. Every mutation is gated by
 * `<Can resource="users" action="manage">`; the whole page is wrapped in a
 * ProtectedRoute so a non-admin who deep-links here sees the Unauthorized view.
 *
 * The backend enforces the same permission server-side AND refuses to disable /
 * demote / delete the last active super_admin (409) — those errors surface as
 * inline toasts. Usernames are operator-entered → rendered as plain text.
 */
import * as React from 'react';
import { Users as UsersIcon, UserPlus, KeyRound, Trash2, RefreshCw, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { api, ApiError } from '@/lib/api';
import type { RolesResponse, User } from '@/lib/types';
import { humanizeAge } from '@/lib/format';
import { Button } from '@/ui/button';
import { Badge } from '@/ui/badge';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Switch } from '@/ui/switch';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { PageHeader } from '@/soc/components/PageHeader';
import { DataTable, type DataTableColumn } from '@/soc/components/DataTable';
import { Can, ProtectedRoute } from '@/soc/components/Can';
import { useAuth } from '@/soc/auth';

/** Human-readable role labels (UI copy; falls back to the raw value). */
const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super admin',
  soc_manager: 'SOC manager',
  analyst_tier2: 'Analyst — Tier 2',
  analyst_tier1: 'Analyst — Tier 1',
  responder: 'Responder',
  auditor: 'Auditor',
};

function roleLabel(role: string): string {
  return ROLE_LABELS[role] ?? role;
}

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

interface UsersPageProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onNavigate?: (page: any, opts?: any) => void;
}

export default function Users(_props: UsersPageProps) {
  return (
    <ProtectedRoute resource="users" action="manage">
      <UsersInner />
    </ProtectedRoute>
  );
}

/**
 * The Users-&-roles body, without the page wrapper. Exported so Settings can embed
 * it (under the Administration group) while the standalone /users route keeps using
 * the default export below during cutover. The Administration section in Settings
 * already gates this behind `users:manage`, so embedding does NOT add a second
 * ProtectedRoute (back-compat: auth-off shows everything).
 */
export function UsersInner() {
  const { username: me } = useAuth();
  const [users, setUsers] = React.useState<User[]>([]);
  const [roles, setRoles] = React.useState<string[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [addOpen, setAddOpen] = React.useState(false);
  const [resetFor, setResetFor] = React.useState<User | null>(null);
  const [busyUser, setBusyUser] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const [u, r] = await Promise.all([api.users.list(), api.roles.get()]);
      setUsers(u.users);
      setRoles((r as RolesResponse).roles);
    } catch (e) {
      toast.error(errMsg(e, 'Could not load users.'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const changeRole = async (user: User, role: string) => {
    if (role === user.role) return;
    setBusyUser(user.username);
    try {
      await api.users.update(user.username, { role });
      toast.success(`Role updated for ${user.username}.`);
      await load();
    } catch (e) {
      toast.error(errMsg(e, 'Could not change role.'));
    } finally {
      setBusyUser(null);
    }
  };

  const toggleActive = async (user: User, active: boolean) => {
    setBusyUser(user.username);
    try {
      await api.users.update(user.username, { active });
      toast.success(active ? `${user.username} enabled.` : `${user.username} disabled.`);
      await load();
    } catch (e) {
      toast.error(errMsg(e, 'Could not update the account.'));
    } finally {
      setBusyUser(null);
    }
  };

  const remove = async (user: User) => {
    if (!window.confirm(`Delete user "${user.username}"? This cannot be undone.`)) return;
    setBusyUser(user.username);
    try {
      await api.users.remove(user.username);
      toast.success(`Deleted ${user.username}.`);
      await load();
    } catch (e) {
      toast.error(errMsg(e, 'Could not delete the user.'));
    } finally {
      setBusyUser(null);
    }
  };

  const columns: DataTableColumn<User>[] = [
    {
      id: 'username',
      header: 'Username',
      sortable: false,
      cell: (u) => (
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{u.username}</span>
          {u.username === me ? (
            <Badge variant="secondary" className="text-[10px]">
              You
            </Badge>
          ) : null}
          {u.must_change_password ? (
            <Badge variant="warning" className="text-[10px]">
              Must reset
            </Badge>
          ) : null}
        </div>
      ),
    },
    {
      id: 'role',
      header: 'Role',
      cell: (u) => (
        <Can resource="users" action="manage" fallback={<span>{roleLabel(u.role)}</span>}>
          <Select
            value={u.role}
            onValueChange={(v) => void changeRole(u, v)}
            disabled={busyUser === u.username}
          >
            <SelectTrigger className="h-8 w-[11rem]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {roles.map((r) => (
                <SelectItem key={r} value={r}>
                  {roleLabel(r)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Can>
      ),
    },
    {
      id: 'active',
      header: 'Active',
      align: 'center',
      cell: (u) => (
        <Switch
          checked={u.active}
          onCheckedChange={(v) => void toggleActive(u, v)}
          disabled={busyUser === u.username}
          aria-label={`${u.active ? 'Disable' : 'Enable'} ${u.username}`}
        />
      ),
    },
    {
      id: 'last_login_at',
      header: 'Last sign-in',
      cell: (u) => (
        <span className="text-sm text-muted-foreground">
          {u.last_login_at ? humanizeAge(u.last_login_at) : 'Never'}
        </span>
      ),
    },
    {
      id: 'created_at',
      header: 'Created',
      cell: (u) => <span className="text-sm text-muted-foreground">{humanizeAge(u.created_at)}</span>,
    },
    {
      id: 'actions',
      header: '',
      align: 'right',
      cell: (u) => (
        <div className="flex items-center justify-end gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8"
            onClick={() => setResetFor(u)}
            disabled={busyUser === u.username}
            aria-label={`Reset password for ${u.username}`}
            title="Reset password"
          >
            <KeyRound className="h-4 w-4" aria-hidden />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 text-critical hover:text-critical"
            onClick={() => void remove(u)}
            disabled={busyUser === u.username}
            aria-label={`Delete ${u.username}`}
            title="Delete user"
          >
            <Trash2 className="h-4 w-4" aria-hidden />
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="space-y-6">
      <PageHeader
        icon={UsersIcon}
        eyebrow="Administration"
        title="Users & roles"
        description="Manage SOC operator accounts and their role-based access."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
              Refresh
            </Button>
            <Can resource="users" action="manage">
              <Button size="sm" onClick={() => setAddOpen(true)}>
                <UserPlus className="h-4 w-4" aria-hidden />
                Add user
              </Button>
            </Can>
          </div>
        }
      />

      <DataTable<User>
        columns={columns}
        rows={users}
        getRowId={(u) => u.username}
        loading={loading}
        ariaLabel="User accounts"
        empty="No users yet."
      />

      <AddUserDialog
        open={addOpen}
        roles={roles}
        defaultRole={roles.includes('analyst_tier1') ? 'analyst_tier1' : roles[0] ?? 'analyst_tier1'}
        onOpenChange={setAddOpen}
        onCreated={() => {
          setAddOpen(false);
          void load();
        }}
      />

      <ResetPasswordDialog
        user={resetFor}
        onOpenChange={(open) => {
          if (!open) setResetFor(null);
        }}
        onDone={() => {
          setResetFor(null);
          void load();
        }}
      />
    </div>
  );
}

// --------------------------------------------------------------------------- //
// Add-user dialog
// --------------------------------------------------------------------------- //
function AddUserDialog({
  open,
  roles,
  defaultRole,
  onOpenChange,
  onCreated,
}: {
  open: boolean;
  roles: string[];
  defaultRole: string;
  onOpenChange: (v: boolean) => void;
  onCreated: () => void;
}) {
  const [username, setUsername] = React.useState('');
  const [password, setPassword] = React.useState('');
  const [role, setRole] = React.useState(defaultRole);
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (open) {
      setUsername('');
      setPassword('');
      setRole(defaultRole);
    }
  }, [open, defaultRole]);

  const submit = async () => {
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      await api.users.create(username.trim(), password, role);
      toast.success(`Created ${username.trim()}. They must reset the password on first sign-in.`);
      onCreated();
    } catch (e) {
      toast.error(errMsg(e, 'Could not create the user.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add user</DialogTitle>
          <DialogDescription>
            The new account must change its password on first sign-in.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4 py-1">
          <div className="space-y-1.5">
            <Label htmlFor="new-user-name">Username</Label>
            <Input
              id="new-user-name"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              autoComplete="off"
              disabled={busy}
              autoFocus
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-pass">Temporary password</Label>
            <Input
              id="new-user-pass"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              autoComplete="new-password"
              disabled={busy}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="new-user-role">Role</Label>
            <Select value={role} onValueChange={setRole} disabled={busy}>
              <SelectTrigger id="new-user-role">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {roles.map((r) => (
                  <SelectItem key={r} value={r}>
                    {roleLabel(r)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !username.trim() || !password}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <UserPlus className="h-4 w-4" aria-hidden />}
            Create
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// --------------------------------------------------------------------------- //
// Reset-password dialog
// --------------------------------------------------------------------------- //
function ResetPasswordDialog({
  user,
  onOpenChange,
  onDone,
}: {
  user: User | null;
  onOpenChange: (v: boolean) => void;
  onDone: () => void;
}) {
  const [password, setPassword] = React.useState('');
  const [busy, setBusy] = React.useState(false);

  React.useEffect(() => {
    if (user) setPassword('');
  }, [user]);

  const submit = async () => {
    if (!user) return;
    if (password.length < 8) {
      toast.error('Password must be at least 8 characters.');
      return;
    }
    setBusy(true);
    try {
      await api.users.update(user.username, { password });
      toast.success(`Password reset for ${user.username}.`);
      onDone();
    } catch (e) {
      toast.error(errMsg(e, 'Could not reset the password.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={!!user} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Reset password</DialogTitle>
          <DialogDescription>
            Set a new temporary password{user ? ` for ${user.username}` : ''}. They must change it on
            next sign-in.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5 py-1">
          <Label htmlFor="reset-pass">New password</Label>
          <Input
            id="reset-pass"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            disabled={busy}
            autoFocus
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button onClick={() => void submit()} disabled={busy || !password}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : <KeyRound className="h-4 w-4" aria-hidden />}
            Reset
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
