const fs = require('fs');
const path = require('path');

const iconFile = path.join(
  __dirname,
  '..',
  'node_modules/@elastic/eui/es/components/icon/icon.js'
);

if (!fs.existsSync(iconFile)) {
  console.log('EUI icon.js not found, skipping patch');
  process.exit(0);
}

let code = fs.readFileSync(iconFile, 'utf8');
const needle = "'./assets/' + typeToPathMap[iconType]";
const replacement = "'./assets/' + typeToPathMap[iconType] + '.js'";

if (code.includes(replacement)) {
  console.log('EUI icon.js already patched');
  process.exit(0);
}

code = code.replace(needle, replacement);
fs.writeFileSync(iconFile, code);
console.log('Patched EUI icon.js for Vite dev-server compatibility');
