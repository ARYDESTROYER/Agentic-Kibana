import React from 'react';
import ReactDOM from 'react-dom';
import { AppMountParameters, CoreStart } from '@kbn/core/public';
import { AppPluginStartDependencies } from './types';
import { TlsocAgenticTriageApp } from './components/app';

export const renderApp = (
  core: CoreStart,
  deps: AppPluginStartDependencies,
  { appBasePath, element }: AppMountParameters
) => {
  ReactDOM.render(
    <TlsocAgenticTriageApp
      basename={appBasePath}
      core={core}
      navigation={deps.navigation}
      data={deps.data}
      dataViews={deps.dataViews}
      share={deps.share}
    />,
    element
  );

  return () => ReactDOM.unmountComponentAtNode(element);
};
