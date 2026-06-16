import { NavigationPublicPluginStart } from '../../../src/plugins/navigation/public';
import { DataPublicPluginStart } from '../../../src/plugins/data/public';
import { DataViewsPublicPluginStart } from '../../../src/plugins/data_views/public';
import { SharePluginStart } from '../../../src/plugins/share/public';

// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TlsocAgenticTriagePluginSetup {}
// eslint-disable-next-line @typescript-eslint/no-empty-interface
export interface TlsocAgenticTriagePluginStart {}

export interface AppPluginStartDependencies {
  navigation: NavigationPublicPluginStart;
  data: DataPublicPluginStart;
  dataViews: DataViewsPublicPluginStart;
  share: SharePluginStart;
}
