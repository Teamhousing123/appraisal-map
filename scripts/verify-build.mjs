import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const buildDirectory = join(process.cwd(), 'build');
const indexPath = join(buildDirectory, 'index.html');

if (!existsSync(indexPath)) {
  throw new Error('Production build is missing build/index.html. Run npm run build first.');
}

const html = readFileSync(indexPath, 'utf8');
const requiredMarkup = [
  ['document language', /<html[^>]+lang=["']en["']/i],
  ['responsive viewport', /<meta[^>]+name=["']viewport["']/i],
  ['private indexing policy', /<meta[^>]+name=["']robots["'][^>]+noindex/i],
  ['page title', /<title>Appraisal Map<\/title>/i],
  ['application root', /<div[^>]+id=["']root["']/i],
  ['JavaScript fallback', /<noscript>[^<]+<\/noscript>/i],
];

const missingMarkup = requiredMarkup
  .filter(([, pattern]) => !pattern.test(html))
  .map(([label]) => label);

if (missingMarkup.length > 0) {
  throw new Error(`Production shell is missing: ${missingMarkup.join(', ')}`);
}

const manifestPath = join(buildDirectory, 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
for (const icon of manifest.icons || []) {
  if (!existsSync(join(buildDirectory, icon.src))) {
    throw new Error(`Manifest icon is missing: ${icon.src}`);
  }
}

console.log('Production shell and install metadata verified.');
