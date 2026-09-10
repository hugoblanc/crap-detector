import { readFileSync } from 'node:fs';

/**
 * Version du générateur, lue depuis le package.json racine.
 * En dev comme après build, ce module vit à deux niveaux sous la racine
 * (src/core/version.js ou dist/core/version.js).
 */
let cachedVersion: string | undefined;

export function appVersion(): string {
  if (cachedVersion === undefined) {
    try {
      const pkg = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
        version?: unknown;
      };
      cachedVersion = typeof pkg.version === 'string' ? pkg.version : '0.0.0-dev';
    } catch {
      cachedVersion = '0.0.0-dev';
    }
  }
  return cachedVersion;
}
