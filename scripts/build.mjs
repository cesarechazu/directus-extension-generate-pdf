import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(SCRIPT_DIR, '..');
const DIST_DIR = path.join(ROOT_DIR, 'dist');
const DIST_FONTS_DIR = path.join(DIST_DIR, 'fonts');

await mkdir(DIST_FONTS_DIR, { recursive: true });

await build({
  entryPoints: [path.join(ROOT_DIR, 'src', 'api.js')],
  outfile: path.join(DIST_DIR, 'api.js'),
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  logLevel: 'info',
});

await copyFile(path.join(ROOT_DIR, 'src', 'app.js'), path.join(DIST_DIR, 'app.js'));
await copyFile(path.join(ROOT_DIR, 'fonts', 'Roboto-Bold.ttf'), path.join(DIST_FONTS_DIR, 'Roboto-Bold.ttf'));
