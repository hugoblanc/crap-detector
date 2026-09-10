/**
 * Analyse des arguments, sans dépendance.
 * Volontairement rudimentaire : options longues uniquement, pas de regroupement
 * de drapeaux courts. Un CLI appelé par une CI et par un hook n'a pas besoin de
 * plus, et une option mal orthographiée doit échouer plutôt que d'être ignorée.
 */
export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Set<string>;
  values: Map<string, string>;
}

/** Options attendant une valeur ; les autres sont des drapeaux booléens. */
const VALUE_OPTIONS = new Set(['root', 'since', 'top', 'baseline', 'limit']);

export function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    command: '',
    positionals: [],
    flags: new Set(),
    values: new Map(),
  };
  let index = 0;
  while (index < argv.length) {
    const argument = argv[index] ?? '';
    index += 1;
    if (!argument.startsWith('--')) {
      if (parsed.command === '') parsed.command = argument;
      else parsed.positionals.push(argument);
      continue;
    }
    const body = argument.slice(2);
    const equals = body.indexOf('=');
    const name = equals === -1 ? body : body.slice(0, equals);
    if (!VALUE_OPTIONS.has(name)) {
      parsed.flags.add(name);
      continue;
    }
    if (equals !== -1) {
      parsed.values.set(name, body.slice(equals + 1));
      continue;
    }
    const value = argv[index];
    if (value === undefined) throw new Error(`l'option --${name} attend une valeur`);
    index += 1;
    parsed.values.set(name, value);
  }
  return parsed;
}

export function numberOption(args: ParsedArgs, name: string, fallback: number): number {
  const raw = args.values.get(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`l'option --${name} attend un nombre positif, reçu '${raw}'`);
  }
  return value;
}
