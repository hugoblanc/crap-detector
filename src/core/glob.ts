/**
 * Appariement de globs minimal, sans dépendance : double étoile, étoile et point d'interrogation.
 * Le segment double-étoile-slash matche zéro ou plusieurs répertoires, donc le glob
 * double-étoile plus slash plus étoile-point-ts matche 'a.ts' comme 'src/sub/a.ts'.
 * Les chemins sont toujours POSIX et relatifs au rootPath.
 */

export function globToRegExp(glob: string): RegExp {
  let pattern = '';
  let i = 0;
  while (i < glob.length) {
    const char = glob.charAt(i);
    if (char === '*') {
      if (glob.startsWith('**/', i)) {
        pattern += '(?:[^/]*/)*';
        i += 3;
      } else if (glob.startsWith('**', i)) {
        pattern += '.*';
        i += 2;
      } else {
        pattern += '[^/]*';
        i += 1;
      }
    } else if (char === '?') {
      pattern += '[^/]';
      i += 1;
    } else if (/[a-zA-Z0-9_\-/]/.test(char)) {
      pattern += char;
      i += 1;
    } else {
      pattern += `\\${char}`;
      i += 1;
    }
  }
  return new RegExp(`^${pattern}$`);
}

export function matchesAnyGlob(globs: RegExp[], path: string): boolean {
  return globs.some((regexp) => regexp.test(path));
}
