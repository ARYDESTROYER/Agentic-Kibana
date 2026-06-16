import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  EuiBadge,
  EuiFlexGroup,
  EuiFlexItem,
  EuiFlyout,
  EuiFlyoutBody,
  EuiFlyoutHeader,
  EuiText,
  EuiTitle,
} from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';
import type { DataPublicPluginStart } from '@kbn/data-plugin/public';
import type { DataViewsPublicPluginStart } from '@kbn/data-views-plugin/public';
import type { SharePluginStart } from '@kbn/share-plugin/public';

import type { ChatContext } from '../../common';
import { TlsocApi } from '../lib/api';
import { makeOpenInDiscover } from '../lib/discover';
import { collectScreenContext } from '../lib/screen_context';
import { Chat } from './chat';

export interface GlobalChatFlyoutProps {
  core: CoreStart;
  data: DataPublicPluginStart;
  dataViews: DataViewsPublicPluginStart;
  share: SharePluginStart;
  onClose: () => void;
}

/**
 * Reuses the in-app `Chat` component (ONE chat engine, two entry points) inside a
 * global header flyout. Passes a `getContext` collector that snapshots the
 * surface at send time, and renders a small read-only "Context" chip from a live
 * preview snapshot so the analyst can see what the agent will see.
 */
export const GlobalChatFlyout: React.FC<GlobalChatFlyoutProps> = ({
  core,
  data,
  dataViews,
  share,
  onClose,
}) => {
  const api = useMemo(() => new TlsocApi(core.http), [core.http]);

  // Keep the latest app id from a `currentAppId$` subscription so the collector
  // (which runs at send time) has a fresh value without re-subscribing.
  const currentAppIdRef = useRef<string | undefined>(undefined);
  const [appLabel, setAppLabel] = useState<string | undefined>(undefined);

  // Resolve the data-view pattern best-effort for the in-flyout "Open in Discover"
  // affordance; default kept stable for ad-hoc spec fallback in discover.ts.
  const patternRef = useRef<string>('all-logs-*');
  const openInDiscover = useMemo(
    () => makeOpenInDiscover(share, dataViews, () => patternRef.current),
    [share, dataViews]
  );

  // Live preview of the context chip (NOT the sent payload). The actual payload
  // is snapshotted at send time inside `getContext` below.
  const [preview, setPreview] = useState<ChatContext>({});

  useEffect(() => {
    const sub = core.application.currentAppId$.subscribe((id) => {
      currentAppIdRef.current = id;
      setAppLabel(id);
    });
    return () => sub.unsubscribe();
  }, [core.application.currentAppId$]);

  // Refresh the preview chip on open and whenever the app changes.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const ctx = await collectScreenContext({
          core,
          data,
          dataViews,
          currentAppId: currentAppIdRef.current,
        });
        if (!cancelled) {
          setPreview(ctx);
          if (ctx.data_view) {
            patternRef.current = ctx.data_view;
          }
        }
      } catch {
        /* preview is best-effort */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [core, data, dataViews, appLabel]);

  const getContext = (): Promise<ChatContext> =>
    collectScreenContext({
      core,
      data,
      dataViews,
      currentAppId: currentAppIdRef.current,
    });

  const timeLabel = preview.time_range
    ? `${preview.time_range.from ?? '?'} → ${preview.time_range.to ?? '?'}`
    : undefined;

  // Each chip value is rendered as plain text only (never executed/linked).
  const chips: string[] = [
    preview.app ? `app: ${preview.app}` : null,
    preview.data_view ? `data view: ${preview.data_view}` : null,
    timeLabel ? `time: ${timeLabel}` : null,
  ].filter(Boolean) as string[];

  return (
    <EuiFlyout
      ownFocus
      size="m"
      onClose={onClose}
      aria-labelledby="tlsocGlobalChatFlyoutTitle"
      data-test-subj="tlsocGlobalChatFlyout"
    >
      <EuiFlyoutHeader hasBorder>
        <EuiTitle size="m">
          <h2 id="tlsocGlobalChatFlyoutTitle">TLSOC Agent</h2>
        </EuiTitle>
        <EuiFlexGroup gutterSize="xs" wrap responsive={false} style={{ marginTop: 8 }}>
          {chips.length ? (
            chips.map((c) => (
              <EuiFlexItem grow={false} key={c}>
                <EuiBadge color="hollow" iconType="visGauge">
                  {c}
                </EuiBadge>
              </EuiFlexItem>
            ))
          ) : (
            <EuiFlexItem grow={false}>
              <EuiText size="xs" color="subdued">
                Context: (none detected)
              </EuiText>
            </EuiFlexItem>
          )}
        </EuiFlexGroup>
      </EuiFlyoutHeader>
      <EuiFlyoutBody>
        <Chat
          api={api}
          openInDiscover={openInDiscover}
          getContext={getContext}
          placeholder="Ask the TLSOC agent about what you're looking at..."
        />
      </EuiFlyoutBody>
    </EuiFlyout>
  );
};
