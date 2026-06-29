/**
 * Admin Sessions console — ALL users' sessions (Round-2 Wave 3).
 *
 * Gated by `users:manage` (the whole page is wrapped in a ProtectedRoute; the
 * backend enforces the same grant + step-up freshness). An admin can: filter by
 * username, force-terminate a single session (with a "notify the user" checkbox in
 * the confirm), and revoke EVERY session for a user (bumps their token_version so
 * already-issued tokens stop working) — also with the notify checkbox.
 *
 * Every session value is request-derived (UA / IP / geo) → rendered PLAIN (#9). No
 * token/secret is ever returned (#10). A force-terminate of a sensitive scope can
 * trigger the step-up re-auth modal (handled globally by <ReauthDialog>).
 */
import * as React from 'react';
import { Network, RefreshCw, Loader2, UserX } from 'lucide-react';
import { toast } from 'sonner';

import { api, ApiError } from '@/lib/api';
import type { Session } from '@/lib/types';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';
import { Label } from '@/ui/label';
import { Checkbox } from '@/ui/checkbox';
import { PageHeader } from '@/soc/components/PageHeader';
import { ProtectedRoute } from '@/soc/components/Can';
import { SessionsTable, sessionDevice, sessionLocation } from '@/soc/pages/Sessions';
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogFooter,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogAction,
  AlertDialogCancel,
} from '@/ui/alert-dialog';

function errMsg(e: unknown, fallback: string): string {
  return e instanceof ApiError && e.message ? e.message : fallback;
}

export interface AdminSessionsPageProps {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  onNavigate?: (page: any, opts?: any) => void;
}

export default function AdminSessions(_props: AdminSessionsPageProps) {
  return (
    <ProtectedRoute resource="users" action="manage">
      <AdminSessionsInner />
    </ProtectedRoute>
  );
}

function AdminSessionsInner() {
  const [sessions, setSessions] = React.useState<Session[]>([]);
  const [loading, setLoading] = React.useState(true);
  const [filter, setFilter] = React.useState('');
  const [busySid, setBusySid] = React.useState<string | null>(null);

  // Force-terminate (single) confirm state.
  const [termTarget, setTermTarget] = React.useState<Session | null>(null);
  const [termNotify, setTermNotify] = React.useState(false);

  // Revoke-all (per user) confirm state.
  const [revokeAllUser, setRevokeAllUser] = React.useState<string | null>(null);
  const [revokeAllNotify, setRevokeAllNotify] = React.useState(false);
  const [busyAll, setBusyAll] = React.useState(false);

  const load = React.useCallback(async () => {
    setLoading(true);
    try {
      const res = await api.admin.sessions.list();
      setSessions(res.sessions ?? []);
    } catch (e) {
      toast.error(errMsg(e, 'Could not load sessions.'));
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const filtered = React.useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter((s) => (s.username ?? '').toLowerCase().includes(q));
  }, [sessions, filter]);

  const doTerminate = async (s: Session, notify: boolean) => {
    setBusySid(s.sid);
    try {
      await api.admin.sessions.revoke(s.sid, notify);
      toast.success('Session terminated.');
      await load();
    } catch (e) {
      toast.error(errMsg(e, 'Could not terminate the session.'));
    } finally {
      setBusySid(null);
    }
  };

  const doRevokeAll = async (username: string, notify: boolean) => {
    setBusyAll(true);
    try {
      const res = await api.admin.users.revokeAll(username, notify);
      toast.success(
        typeof res.revoked === 'number'
          ? `Revoked ${res.revoked} session${res.revoked === 1 ? '' : 's'} for ${username}.`
          : `Revoked all sessions for ${username}.`,
      );
      await load();
    } catch (e) {
      toast.error(errMsg(e, 'Could not revoke the user’s sessions.'));
    } finally {
      setBusyAll(false);
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        icon={Network}
        eyebrow="Administration"
        title="Active sessions"
        description="Review and force-terminate sessions across all accounts."
        actions={
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            <RefreshCw className={loading ? 'h-4 w-4 animate-spin' : 'h-4 w-4'} aria-hidden />
            Refresh
          </Button>
        }
      />

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="admin-session-filter" className="text-xs">
            Filter by user
          </Label>
          <Input
            id="admin-session-filter"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="username…"
            className="h-9 w-56"
          />
        </div>
        {filter && revokeAllCandidate(filtered) ? (
          <Button
            variant="outline"
            size="sm"
            className="text-critical hover:text-critical"
            onClick={() => {
              setRevokeAllUser(revokeAllCandidate(filtered));
              setRevokeAllNotify(false);
            }}
          >
            <UserX className="h-4 w-4" aria-hidden />
            Revoke all for {revokeAllCandidate(filtered)}
          </Button>
        ) : null}
      </div>

      <SessionsTable
        sessions={filtered}
        loading={loading}
        busySid={busySid}
        showUser
        revokeLabel="Terminate"
        ariaLabel="All active sessions"
        onRevoke={(s) => {
          setTermTarget(s);
          setTermNotify(false);
        }}
      />

      {/* Force-terminate (single) confirm with notify checkbox */}
      <AlertDialog
        open={!!termTarget}
        onOpenChange={(open) => {
          if (!open) setTermTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Terminate this session?</AlertDialogTitle>
            <AlertDialogDescription>
              {termTarget?.username ? (
                <>
                  This signs out <span className="font-medium text-foreground">{termTarget.username}</span> on the
                  selected device immediately.
                </>
              ) : (
                'This signs out the selected device immediately.'
              )}
              {termTarget ? (
                <span className="mt-2 block text-xs text-muted-foreground">
                  {sessionDevice(termTarget)}
                  {sessionLocation(termTarget) ? ` · ${sessionLocation(termTarget)}` : ''}
                </span>
              ) : null}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox
              checked={termNotify}
              onCheckedChange={(v) => setTermNotify(v === true)}
              aria-label="Notify the user"
            />
            Notify the user by email
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              onClick={() => {
                const t = termTarget;
                const notify = termNotify;
                setTermTarget(null);
                if (t) void doTerminate(t, notify);
              }}
            >
              Terminate
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Revoke-all (per user) confirm with notify checkbox */}
      <AlertDialog
        open={!!revokeAllUser}
        onOpenChange={(open) => {
          if (!open) setRevokeAllUser(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke all sessions for {revokeAllUser}?</AlertDialogTitle>
            <AlertDialogDescription>
              Every active session for{' '}
              <span className="font-medium text-foreground">{revokeAllUser}</span> is signed out and
              their already-issued tokens stop working. They will need to sign in again everywhere.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <label className="flex items-center gap-2 text-sm text-foreground">
            <Checkbox
              checked={revokeAllNotify}
              onCheckedChange={(v) => setRevokeAllNotify(v === true)}
              aria-label="Notify the user"
            />
            Notify the user by email
          </label>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busyAll}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={busyAll}
              onClick={() => {
                const u = revokeAllUser;
                const notify = revokeAllNotify;
                setRevokeAllUser(null);
                if (u) void doRevokeAll(u, notify);
              }}
            >
              {busyAll ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden /> : null}
              Revoke all
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

/** When the filtered set is exactly one user, expose a "revoke all for X" affordance. */
function revokeAllCandidate(sessions: Session[]): string | null {
  const users = new Set(sessions.map((s) => s.username ?? '').filter(Boolean));
  if (users.size === 1) {
    const [only] = Array.from(users);
    return only || null;
  }
  return null;
}
