/**
 * Vite plugin that rewrites EUI's dynamic icon import() to use import.meta.glob
 * so Vite/Rollup can resolve and bundle icon chunks at build time.
 *
 * Without this, EUI icon.js does:
 *   import('./assets/' + typeToPathMap[iconType] + '.js')
 * which Rollup can't statically analyze, leaving runtime imports to raw ESM files
 * that contain bare `import 'react'` specifiers browsers can't resolve.
 */
function euiIconsPlugin() {
  const EUI_ICON_JS_RE = /node_modules[\\/]@elastic[\\/]eui[\\/]es[\\/]components[\\/]icon[\\/]icon\.js$/;

  return {
    name: 'vite-plugin-eui-icons',
    enforce: 'pre',

    transform(code, id) {
      if (!EUI_ICON_JS_RE.test(id)) return null;

      const importPattern = /import\(\s*\/\*[\s\S]*?\*\/[\s\S]*?'\.\/assets\/' \+ typeToPathMap\[iconType\](?:\s*\+\s*'\.js')?\s*\)/;
      if (!importPattern.test(code)) {
        console.log('[eui-icons] Could not find dynamic import pattern in icon.js');
        return null;
      }

      const replacement = `new Promise(function(resolve) {
        var _globModules = import.meta.glob('./assets/*.js', {eager: false});
        var _iconKey = './assets/' + typeToPathMap[iconType] + '.js';
        if (_globModules[_iconKey]) { resolve(_globModules[_iconKey]()); }
        else { resolve({icon: null}); }
      })`;

      const newCode = code.replace(importPattern, replacement);

      return { code: newCode, map: null };
    },
  };
}

module.exports = euiIconsPlugin;
