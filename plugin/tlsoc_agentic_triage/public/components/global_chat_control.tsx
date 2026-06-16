import React, { useState } from 'react';
import { EuiButtonIcon } from '@elastic/eui';
import type { CoreStart } from '@kbn/core/public';
import type { DataPublicPluginStart } from '@kbn/data-plugin/public';
import type { DataViewsPublicPluginStart } from '@kbn/data-views-plugin/public';
import type { SharePluginStart } from '@kbn/share-plugin/public';

import { GlobalChatFlyout } from './global_chat_flyout';

export interface GlobalChatControlProps {
  core: CoreStart;
  data: DataPublicPluginStart;
  dataViews: DataViewsPublicPluginStart;
  share: SharePluginStart;
}

/**
 * The persistent header button (registered via
 * `core.chrome.navControls.registerRight`) that opens the context-aware TLSOC
 * agent chat flyout from ANY Kibana app.
 */
export const GlobalChatControl: React.FC<GlobalChatControlProps> = ({
  core,
  data,
  dataViews,
  share,
}) => {
  const [open, setOpen] = useState(false);

  return (
    <>
      <EuiButtonIcon
        iconType="discuss"
        color="text"
        display="empty"
        aria-label="TLSOC Agent Chat"
        title="TLSOC Agent Chat"
        data-test-subj="tlsocGlobalChatButton"
        onClick={() => setOpen((v) => !v)}
      />
      {open ? (
        <GlobalChatFlyout
          core={core}
          data={data}
          dataViews={dataViews}
          share={share}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
};
