import fs from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';

const input = path.resolve(process.argv[2] || 'index.html');
const folder = path.dirname(input);
const html = await fs.readFile(input, 'utf8');

// Find the viewer's inline JavaScript.
const scriptPattern = /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi;
const scripts = [...html.matchAll(scriptPattern)];
const modules = scripts.filter(m =>
  /\btype\s*=\s*["']module["']/i.test(m[1])
);

if (modules.length !== 1 || /\bsrc\s*=/i.test(modules[0][1])) {
  throw new Error(
    'Expected one inline module script, as in our Three.js HTML.'
  );
}

let source = modules[0][2];

// Locate the GLB referenced by the viewer.
const loads = [...source.matchAll(
  /\bloader\.loadAsync\s*\(\s*(['"])([^'"]+\.glb)\1/g
)];

if (loads.length !== 1) {
  throw new Error(
    'Expected one loader.loadAsync("./model.glb", ...) call.'
  );
}

const reference = loads[0][2];

if (/^(?:[a-z]+:|\/)/i.test(reference)) {
  throw new Error('Use a relative local GLB path in your viewer.');
}

const model = await fs.readFile(path.resolve(folder, reference));

// Inspect the GLB header and metadata.
if (
  model.length < 20 ||
  model.readUInt32LE(0) !== 0x46546c67 ||
  model.readUInt32LE(4) !== 2 ||
  model.readUInt32LE(8) !== model.length ||
  model.readUInt32LE(16) !== 0x4e4f534a
) {
  throw new Error('Invalid glTF 2.0 binary file.');
}

const jsonSize = model.readUInt32LE(12);

if (20 + jsonSize > model.length) {
  throw new Error('Truncated GLB.');
}

const doc = JSON.parse(
  model.subarray(20, 20 + jsonSize).toString('utf8')
);

// External decoder files would prevent single-file operation.
const extensions = JSON.stringify(doc);

for (const name of [
  'KHR_draco_mesh_compression',
  'EXT_meshopt_compression',
  'KHR_meshopt_compression',
  'KHR_texture_basisu'
]) {
  if (extensions.includes('"' + name + '"')) {
    throw new Error(
      'This packager requires an uncompressed GLB. ' +
      'Use the shaded-model export.'
    );
  }
}

for (const asset of [
  ...(doc.buffers || []),
  ...(doc.images || [])
]) {
  if (asset.uri && !asset.uri.startsWith('data:')) {
    throw new Error(
      'The GLB has external assets. Embed them before packaging.'
    );
  }
}

// Load the embedded model instead of fetching a neighbouring file.
source = source.replace(
  loads[0][0],
  'loader.loadAsync(packagedModelURL'
);

const bootstrap = `
const packagedModelURL = (() => {
  const embedded = document.getElementById("bone-atlas-glb");
  const binary = atob(embedded.textContent.trim());
  const bytes = new Uint8Array(binary.length);

  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  embedded.remove();

  return URL.createObjectURL(
    new Blob([bytes], { type: "model/gltf-binary" })
  );
})();
`;

// Bundle Three.js, controls, loaders, and any exporter imports.
const result = await build({
  stdin: {
    contents: bootstrap + '\n' + source,
    resolveDir: folder,
    sourcefile: 'bone-atlas-entry.js',
    loader: 'js'
  },
  bundle: true,
  splitting: false,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  legalComments: 'inline',
  metafile: true,
  write: false,
  outfile: 'offline.js'
});

if (
  result.outputFiles.length !== 1 ||
  Object.values(result.metafile.outputs).some(o => o.imports.length)
) {
  throw new Error('Bundling left external JavaScript dependencies.');
}

// Preserve the HTML/CSS; remove the original module and import map.
let output = html.replace(scriptPattern, (whole, attributes) =>
  /\btype\s*=\s*["'](?:module|importmap)["']/i.test(attributes)
    ? ''
    : whole
);

if (
  /<(?:script|link|img|iframe)\b[^>]*\b(?:src|href)\s*=/i.test(output) ||
  /@import\b|url\s*\(/i.test(output)
) {
  throw new Error(
    'Additional HTML/CSS assets need embedding. ' +
    'This script targets our inline viewer.'
  );
}

const code = result.outputFiles[0].text
  .replace(/<\/script/gi, '<\\/script');

  const payload =
  '<script id="bone-atlas-glb" type="application/octet-stream">' +
  model.toString('base64') +
  '</script>\n<script>' +
  'requestAnimationFrame(() => setTimeout(() => {' +
  'try {' +
  code +
  '} catch (error) {' +
  'console.error(error);' +
  'document.querySelector(".loading-spinner")?.remove();' +
  'const message = document.getElementById("loading-message");' +
  'if (message) message.textContent = "Could not start viewer: " + error.message;' +
  '}' +
  '}, 0));' +
  '</script>\n';

if (!/<\/body\s*>/i.test(output)) {
  throw new Error('Missing closing body tag.');
}

output = output.replace(
  /<\/body\s*>/i,
  () => payload + '</body>'
);

// Retain the bundled library's license.
const threeLicense = await fs.readFile(
  path.join(folder, 'node_modules/three/LICENSE'),
  'utf8'
);

output +=
  '\n<!-- Bundled Three.js license:\n' +
  threeLicense +
  '\n-->\n';

const destination = path.join(
  folder, 'dist', 'bone-atlas-offline.html'
);

await fs.mkdir(path.dirname(destination), { recursive: true });
await fs.writeFile(destination, output);

console.log('Created: ' + destination);
console.log(
  (Buffer.byteLength(output) / 1024 / 1024).toFixed(1) + ' MB'
);
