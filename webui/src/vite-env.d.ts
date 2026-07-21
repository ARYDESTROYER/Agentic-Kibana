/// <reference types="vite/client" />

interface TlsocInjectedReleaseIdentity {
  version: string;
  channel: 'testing' | 'stable';
  commitSha: string;
  buildTime: string;
}

declare const __TLSOC_RELEASE_IDENTITY__: Readonly<TlsocInjectedReleaseIdentity>;

declare module '*.css?url' {
  const url: string;
  export default url;
}
