import React, { useEffect, useState } from 'react';
import type { CoreStart } from '@kbn/core/public';
import { TlsocApi } from '../lib/api';
import { LogOverview } from './log_overview';

interface Props {
  /** The Discover doc-viewer render props (DataTableRecord on `hit`). Typed loosely
   * so a contract change in unifiedDocViewer can't break the build. */
  docProps: any;
  getStartServices: () => Promise<[CoreStart, unknown, unknown]>;
}

/**
 * Feature 2: the Discover custom doc-viewer tab body. It is created at plugin
 * SETUP time, so it resolves the http service lazily via getStartServices, then
 * renders the shared LogOverview against the full ES hit (`raw._source`).
 */
export const DocViewerOverview: React.FC<Props> = ({ docProps, getStartServices }) => {
  const [api, setApi] = useState<TlsocApi | null>(null);
  useEffect(() => {
    let cancelled = false;
    getStartServices()
      .then(([core]) => {
        if (!cancelled) {
          setApi(new TlsocApi(core.http));
        }
      })
      .catch(() => {
        /* if start services are unavailable the tab simply renders nothing */
      });
    return () => {
      cancelled = true;
    };
  }, [getStartServices]);

  const raw = docProps?.hit?.raw ?? {};
  const source = (raw && raw._source) || docProps?.hit?.flattened || {};
  if (!api) {
    return null;
  }
  return <LogOverview api={api} source={source} index={raw?._index} id={raw?._id} />;
};

// Default export so it can be lazily imported if desired.
export default DocViewerOverview;
