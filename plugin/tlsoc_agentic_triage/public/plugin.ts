import React from 'react';
import { AppMountParameters, CoreSetup, CoreStart, Plugin } from '@kbn/core/public';
import { toMountPoint } from '@kbn/react-kibana-mount';
import {
  TlsocAgenticTriagePluginSetup,
  TlsocAgenticTriagePluginStart,
  AppPluginStartDependencies,
} from './types';
import { PLUGIN_ID, PLUGIN_NAME } from '../common';
import { GlobalChatControl } from './components/global_chat_control';

export class TlsocAgenticTriagePlugin
  implements Plugin<TlsocAgenticTriagePluginSetup, TlsocAgenticTriagePluginStart>
{
  /** Tear-down for the header nav control registered in start(). */
  private unmountGlobalChat?: () => void;

  public setup(core: CoreSetup): TlsocAgenticTriagePluginSetup {
    // Register a single application into the side navigation menu.
    core.application.register({
      id: PLUGIN_ID,
      title: PLUGIN_NAME,
      euiIconType: 'securityAnalyticsApp',
      order: 9000,
      async mount(params: AppMountParameters) {
        const { renderApp } = await import('./application');
        const [coreStart, depsStart] = await core.getStartServices();
        return renderApp(coreStart, depsStart as AppPluginStartDependencies, params);
      },
    });

    return {};
  }

  public start(
    core: CoreStart,
    plugins: AppPluginStartDependencies
  ): TlsocAgenticTriagePluginStart {
    // Feature 1: a persistent header button, registered on the right of the
    // Kibana chrome header. Because it lives in chrome (not our app), it is
    // visible from EVERY Kibana app, not just ours. The flyout it opens reuses
    // the same Chat engine and attaches a context snapshot at send time.
    const mount = toMountPoint(
      React.createElement(GlobalChatControl, {
        core,
        data: plugins.data,
        dataViews: plugins.dataViews,
        share: plugins.share,
      }),
      core.rendering
    );
    // navControls.registerRight has no unregister API; we keep the mount's
    // unmount fn and call it in stop() so React tears down cleanly.
    core.chrome.navControls.registerRight({
      order: 1000,
      mount: (element: HTMLElement) => {
        this.unmountGlobalChat = mount(element);
        return () => {
          this.unmountGlobalChat?.();
          this.unmountGlobalChat = undefined;
        };
      },
    });

    return {};
  }

  public stop() {
    this.unmountGlobalChat?.();
    this.unmountGlobalChat = undefined;
  }
}
