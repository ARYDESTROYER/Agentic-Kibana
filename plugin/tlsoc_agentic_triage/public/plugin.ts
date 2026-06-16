import { AppMountParameters, CoreSetup, CoreStart, Plugin } from '@kbn/core/public';
import {
  TlsocAgenticTriagePluginSetup,
  TlsocAgenticTriagePluginStart,
  AppPluginStartDependencies,
} from './types';
import { PLUGIN_ID, PLUGIN_NAME } from '../common';

export class TlsocAgenticTriagePlugin
  implements Plugin<TlsocAgenticTriagePluginSetup, TlsocAgenticTriagePluginStart>
{
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

  public start(core: CoreStart): TlsocAgenticTriagePluginStart {
    return {};
  }

  public stop() {}
}
