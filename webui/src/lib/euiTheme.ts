/**
 * Runtime EUI theme switcher.
 *
 * EUI ships prebuilt light/dark stylesheets. We import both as URLs (Vite emits
 * them as assets) and toggle which `<link>` is enabled, so the app supports a
 * light/dark switch without a build per theme.
 */
// eslint-disable-next-line import/no-unresolved
import lightThemeUrl from '@elastic/eui/dist/eui_theme_light.min.css?url';
// eslint-disable-next-line import/no-unresolved
import darkThemeUrl from '@elastic/eui/dist/eui_theme_dark.min.css?url';

const LIGHT_ID = 'eui-theme-light';
const DARK_ID = 'eui-theme-dark';

function ensureLink(id: string, href: string): HTMLLinkElement {
  let link = document.getElementById(id) as HTMLLinkElement | null;
  if (!link) {
    link = document.createElement('link');
    link.id = id;
    link.rel = 'stylesheet';
    link.href = href;
    document.head.appendChild(link);
  }
  return link;
}

/** Enable the dark or light EUI stylesheet (disabling the other). */
export function applyEuiTheme(dark: boolean): void {
  const light = ensureLink(LIGHT_ID, lightThemeUrl);
  const darkLink = ensureLink(DARK_ID, darkThemeUrl);
  light.disabled = dark;
  darkLink.disabled = !dark;
  document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
}
