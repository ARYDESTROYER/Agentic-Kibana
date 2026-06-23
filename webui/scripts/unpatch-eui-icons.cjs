const fs = require('fs');
const path = require('path');

const iconFile = path.join(
  __dirname,
  '..',
  'node_modules/@elastic/eui/es/components/icon/icon.js'
);

if (!fs.existsSync(iconFile)) {
  console.log('EUI icon.js not found, skipping unpatch');
  process.exit(0);
}

let code = fs.readFileSync(iconFile, 'utf8');
const patched = "'./assets/' + typeToPathMap[iconType] + '.js'";
const original = "'./assets/' + typeToPathMap[iconType]";

if (!code.includes(patched)) {
  console.log('EUI icon.js already unpatched');
  process.exit(0);
}

code = code.replace(patched, original);
fs.writeFileSync(iconFile, code);
console.log('Restored EUI icon.js for production build');
