import { PluginInitializerContext, PluginConfigDescriptor } from '@kbn/core/server';
import { configSchema, TlsocConfig } from './config';

//  This exports static code and TypeScript types,
//  as well as, Kibana Platform `plugin()` initializer.

export async function plugin(initializerContext: PluginInitializerContext) {
  const { TlsocAgenticTriagePlugin } = await import('./plugin');
  return new TlsocAgenticTriagePlugin(initializerContext);
}

export const config: PluginConfigDescriptor<TlsocConfig> = {
  schema: configSchema,
};

export type { TlsocAgenticTriagePluginSetup, TlsocAgenticTriagePluginStart } from './types';
