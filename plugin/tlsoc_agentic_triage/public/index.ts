import './index.scss';

import { TlsocAgenticTriagePlugin } from './plugin';

// This exports static code and TypeScript types,
// as well as, Kibana Platform `plugin()` initializer.
export function plugin() {
  return new TlsocAgenticTriagePlugin();
}
export type { TlsocAgenticTriagePluginSetup, TlsocAgenticTriagePluginStart } from './types';
