import {
  PluginInitializerContext,
  CoreSetup,
  CoreStart,
  Plugin,
  Logger,
} from '@kbn/core/server';

import { TlsocAgenticTriagePluginSetup, TlsocAgenticTriagePluginStart } from './types';
import { defineRoutes } from './routes';
import { TlsocConfig } from './config';

export class TlsocAgenticTriagePlugin
  implements Plugin<TlsocAgenticTriagePluginSetup, TlsocAgenticTriagePluginStart>
{
  private readonly logger: Logger;
  private readonly initializerContext: PluginInitializerContext;

  constructor(initializerContext: PluginInitializerContext) {
    this.logger = initializerContext.logger.get();
    this.initializerContext = initializerContext;
  }

  public setup(core: CoreSetup) {
    const config = this.initializerContext.config.get<TlsocConfig>();
    this.logger.debug(`tlsocAgenticTriage: Setup (backendUrl=${config.backendUrl})`);

    const router = core.http.createRouter();

    // Register server side proxy routes. The browser only ever talks to Kibana;
    // these routes forward to the backend so session/CSRF/TLS carry.
    defineRoutes(router, config.backendUrl, this.logger);

    return {};
  }

  public start(core: CoreStart) {
    this.logger.debug('tlsocAgenticTriage: Started');
    return {};
  }

  public stop() {}
}
