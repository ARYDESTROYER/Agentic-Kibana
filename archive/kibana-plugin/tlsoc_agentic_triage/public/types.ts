import { NavigationPublicPluginStart } from '@kbn/navigation-plugin/public';
import { DataPublicPluginStart } from '@kbn/data-plugin/public';
import { DataViewsPublicPluginStart } from '@kbn/data-views-plugin/public';
import { SharePluginStart } from '@kbn/share-plugin/public';

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TlsocAgenticTriagePluginSetup {}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TlsocAgenticTriagePluginStart {}

/** Optional setup-time deps. unifiedDocViewer is typed loosely (its registry
 * contract varies by version) and guarded at the call site (Feature 2). */
export interface AppPluginSetupDependencies {
  unifiedDocViewer?: any;
}

export interface AppPluginStartDependencies {
  navigation: NavigationPublicPluginStart;
  data: DataPublicPluginStart;
  dataViews: DataViewsPublicPluginStart;
  share: SharePluginStart;
}
