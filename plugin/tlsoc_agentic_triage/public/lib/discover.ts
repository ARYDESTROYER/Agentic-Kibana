import type { DataViewsPublicPluginStart } from '../../../../src/plugins/data_views/public';
import type { SharePluginStart } from '../../../../src/plugins/share/public';

const DISCOVER_APP_LOCATOR = 'DISCOVER_APP_LOCATOR';

/**
 * Build a reusable helper that opens Discover for a KQL query against the
 * configured data-view pattern. Shared by Surfaces 1 & 2.
 */
export function makeOpenInDiscover(
  share: SharePluginStart,
  dataViews: DataViewsPublicPluginStart,
  getPattern: () => string
) {
  return async function openInDiscover(
    kql: string,
    timeFrom?: string,
    timeTo?: string,
    patternOverride?: string
  ): Promise<void> {
    const locator = share.url.locators.get(DISCOVER_APP_LOCATOR);
    if (!locator) {
      throw new Error('Discover locator is not available');
    }

    const pattern = patternOverride || getPattern();

    let dataViewId: string | undefined;
    try {
      const ids = await dataViews.getIdsWithTitle();
      const match = ids.find((dv) => dv.title === pattern);
      dataViewId = match?.id;
    } catch {
      dataViewId = undefined;
    }

    const params: Record<string, any> = {
      query: { query: kql || '', language: 'kuery' },
      timeRange: { from: timeFrom || 'now-24h', to: timeTo || 'now' },
    };

    if (dataViewId) {
      params.dataViewId = dataViewId;
    } else {
      // Fall back to an ad-hoc data view spec.
      params.dataViewSpec = { title: pattern, timeFieldName: '@timestamp' };
    }

    await locator.navigate(params);
  };
}

export type OpenInDiscover = ReturnType<typeof makeOpenInDiscover>;
