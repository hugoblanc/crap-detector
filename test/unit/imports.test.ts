import { afterEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Project } from 'ts-morph';
import type { SourceFile } from 'ts-morph';
import {
  areLinked,
  buildImportGraph,
  classifySpecifier,
  fileImports,
  isTypesModule,
  normalizeRelative,
  packageNameOf,
  resolveRelativeImport,
  runtimeImports,
} from '../../src/imports/extract.js';
import { findCycles } from '../../src/imports/graph.js';
import type { ImportRef } from '../../src/imports/extract.js';
import {
  isDeclared,
  matchesAliasPattern,
  readManifest,
} from '../../src/imports/manifest.js';
import type { Manifest } from '../../src/imports/manifest.js';
import { ambientModulePatterns, specifierResolver } from '../../src/imports/resolve.js';
import { analyzeImports, importFindings } from '../../src/imports/analyze.js';
import type { DependencyContext } from '../../src/imports/analyze.js';

const created: string[] = [];

function makeProject(files: Record<string, string>): Map<string, SourceFile> {
  const project = new Project({ useInMemoryFileSystem: true, skipAddingFilesFromTsConfig: true });
  const sources = new Map<string, SourceFile>();
  for (const [path, content] of Object.entries(files)) {
    sources.set(path, project.createSourceFile(path, content));
  }
  return sources;
}

function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'crap-detector-imports-'));
  created.push(root);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, dirname(rel)), { recursive: true });
    writeFileSync(join(root, rel), content, 'utf8');
  }
  return root;
}

afterEach(() => {
  while (created.length > 0) {
    rmSync(created.pop() ?? '', { recursive: true, force: true });
  }
});

describe('classifySpecifier', () => {
  it('distingue relatif, absolu, natif, subpath et paquet', () => {
    expect(classifySpecifier('./a.js')).toBe('relative');
    expect(classifySpecifier('../core/a.js')).toBe('relative');
    expect(classifySpecifier('/etc/passwd')).toBe('absolute');
    expect(classifySpecifier('node:fs')).toBe('builtin');
    expect(classifySpecifier('fs')).toBe('builtin');
    expect(classifySpecifier('fs/promises')).toBe('builtin');
    expect(classifySpecifier('#core/logger')).toBe('subpath');
    expect(classifySpecifier('ts-morph')).toBe('bare');
    expect(classifySpecifier('@scope/pkg/sub')).toBe('bare');
  });
});

describe('packageNameOf', () => {
  it('garde un segment, ou deux pour un paquet scopé', () => {
    expect(packageNameOf('lodash')).toBe('lodash');
    expect(packageNameOf('lodash/merge')).toBe('lodash');
    expect(packageNameOf('@scope/pkg')).toBe('@scope/pkg');
    expect(packageNameOf('@scope/pkg/deep/path')).toBe('@scope/pkg');
  });
});

describe('fileImports', () => {
  it('couvre import, export from, import dynamique et require', () => {
    const sources = makeProject({
      'src/a.ts': [
        "import { a } from './b.js';",
        "import type { T } from './types.js';",
        "export { c } from './c.js';",
        "export * from './d.js';",
        'export const load = async () => import("./lazy.js");',
        "const legacy = require('legacy-pkg');",
        'void legacy;',
      ].join('\n'),
    });
    const refs = fileImports(sources.get('src/a.ts') as SourceFile);
    expect(refs.map((ref) => [ref.specifier, ref.kind])).toEqual([
      ['./b.js', 'import'],
      ['./types.js', 'import'],
      ['./c.js', 'export-from'],
      ['./d.js', 'export-from'],
      ['./lazy.js', 'dynamic'],
      ['legacy-pkg', 'require'],
    ]);
  });

  it('ignore un export sans module et un require sans littéral', () => {
    const sources = makeProject({
      'src/a.ts': [
        'const name = "dyn";',
        'export const value = 1;',
        'export { value as alias };',
        'const mod = require(name);',
        'void mod;',
      ].join('\n'),
    });
    expect(fileImports(sources.get('src/a.ts') as SourceFile)).toEqual([]);
  });
});

describe('normalizeRelative', () => {
  it('résout . et .. par rapport au dossier du fichier', () => {
    expect(normalizeRelative('src/core/a.ts', './b.js')).toBe('src/core/b.js');
    expect(normalizeRelative('src/core/a.ts', '../metrics/b.js')).toBe('src/metrics/b.js');
    expect(normalizeRelative('src/a.ts', './deep/./b.js')).toBe('src/deep/b.js');
  });

  it('rend undefined quand le chemin sort de la racine', () => {
    expect(normalizeRelative('src/a.ts', '../../outside.js')).toBeUndefined();
  });
});

describe('resolveRelativeImport', () => {
  const known = new Set(['src/a.ts', 'src/b.ts', 'src/deep/index.ts', 'src/c.tsx']);

  it('remappe l’extension .js de sortie vers la source .ts', () => {
    expect(resolveRelativeImport('src/a.ts', './b.js', known)).toBe('src/b.ts');
  });

  it('accepte un import sans extension et un dossier avec index', () => {
    expect(resolveRelativeImport('src/a.ts', './c', known)).toBe('src/c.tsx');
    expect(resolveRelativeImport('src/a.ts', './deep', known)).toBe('src/deep/index.ts');
  });

  it('rend undefined sur une cible inconnue', () => {
    expect(resolveRelativeImport('src/a.ts', './absent.js', known)).toBeUndefined();
  });
});

describe('buildImportGraph', () => {
  const imports = new Map<string, ImportRef[]>([
    ['src/a.ts', [
      { specifier: './b.js', kind: 'import', specifierKind: 'relative', line: 1 },
      { specifier: 'ts-morph', kind: 'import', specifierKind: 'bare', line: 2 },
    ]],
    ['src/b.ts', [
      { specifier: './c.js', kind: 'import', specifierKind: 'relative', line: 1 },
    ]],
    ['src/c.ts', []],
  ]);

  it('ne garde que les arêtes internes au scope', () => {
    const graph = buildImportGraph(imports);
    expect([...(graph.edges.get('src/a.ts') ?? [])]).toEqual(['src/b.ts']);
    expect([...(graph.edges.get('src/c.ts') ?? [])]).toEqual([]);
  });

  it('areLinked est vrai dans les deux sens, jusqu’à deux imports, et faux au-delà', () => {
    const graph = buildImportGraph(new Map([
      ...imports,
      ['src/c.ts', [{ specifier: './d.js', kind: 'import', specifierKind: 'relative', line: 1 }]],
      ['src/d.ts', []],
    ]));
    expect(areLinked(graph, 'src/a.ts', 'src/b.ts')).toBe(true);
    expect(areLinked(graph, 'src/b.ts', 'src/a.ts')).toBe(true);
    expect(areLinked(graph, 'src/c.ts', 'src/a.ts')).toBe(true);
    expect(areLinked(graph, 'src/a.ts', 'src/d.ts')).toBe(false);
  });
});

describe('isTypesModule', () => {
  it('retient un fichier de types seuls, écarte toute valeur exportée à l’exécution', () => {
    const sources = makeProject({
      'src/types.ts': 'export interface A { run(): void }\nexport type B = A[];\n',
      'src/ambient.d.ts': 'export interface A { value: number }\nexport const KEY: string;\n',
      'src/constants.ts': 'export type Key = string;\nexport const KEYS = [\'a\'] as const;\n',
      'src/schema.ts': "import { z } from 'zod';\nexport type User = { id: string };\nexport const userSchema = z.object({ id: z.string() });\n",
      'src/logic.ts': 'export interface A { value: number }\nexport const make = (): A => ({ value: 1 });\n',
      'src/enum.ts': 'export type Key = string;\nexport enum Color { Red }\n',
      'src/barrel.ts': "export * from './types.js';\nexport type Alias = number;\n",
    });
    expect([...sources].filter(([, source]) => isTypesModule(source)).map(([file]) => file))
      .toEqual(['src/types.ts', 'src/ambient.d.ts']);
  });
});

describe('cycles à l’exécution', () => {
  function cyclesOf(files: Record<string, string>, tsconfig: object = {}, extra: Record<string, string> = {}): string[][] {
    const root = makeRoot({ 'package.json': '{}', 'tsconfig.json': JSON.stringify(tsconfig), ...extra });
    return findCycles(analyzeImports(root, makeProject(files)).cycleGraph).map((cycle) => cycle.files);
  }

  it('ignore un cycle qui ne passe que par des imports de types', () => {
    expect(cyclesOf({
      'src/a.ts': "import type { B } from './b.js';\nimport { helper } from './c.js';\nexport const a = (b: B): number => helper(b.size);\n",
      'src/b.ts': "import { a } from './a.js';\nexport interface B { size: number }\nexport const b = a;\n",
      'src/c.ts': "import { B } from './b.js';\nexport const helper = (size: number): number => size;\nexport type C = B;\n",
    })).toEqual([]);
  });

  it('garde un cycle réel, et ignore un import() dynamique', () => {
    expect(cyclesOf({
      'src/a.ts': "import { b } from './b.js';\nexport const a = (): number => b + 1;\n",
      'src/b.ts': "import { a } from './a.js';\nexport const b = 1;\nexport const loop = a;\n",
      'src/c.ts': "import { lazy } from './d.js';\nexport const c = lazy;\n",
      'src/d.ts': "export const lazy = async (): Promise<unknown> => import('./c.js');\n",
    })).toEqual([['src/a.ts', 'src/b.ts']]);
  });

  it('avec verbatimModuleSyntax, compte un import { type X } qui survit à l’émission', () => {
    const files = {
      'src/a.ts': "import { type B } from './b.js';\nexport const a = (b: B): B => b;\n",
      'src/b.ts': "import { a } from './a.js';\nexport interface B { size: number }\nexport const b = a;\n",
    };
    expect(cyclesOf(files)).toEqual([]);
    expect(cyclesOf(files, { compilerOptions: { verbatimModuleSyntax: true } })).toEqual([['src/a.ts', 'src/b.ts']]);
  });

  it('avec emitDecoratorMetadata, compte l’injection croisée de deux services', () => {
    const files = {
      'src/a.service.ts': [
        "import { BService } from './b.service.js';",
        'declare const Injectable: () => ClassDecorator;',
        '@Injectable()',
        'export class AService { constructor(private readonly b: BService) {} }',
      ].join('\n'),
      'src/b.service.ts': [
        "import { AService } from './a.service.js';",
        'declare const Injectable: () => ClassDecorator;',
        '@Injectable()',
        'export class BService { constructor(private readonly a: AService) {} }',
      ].join('\n'),
    };
    const options = { experimentalDecorators: true, emitDecoratorMetadata: true };
    expect(cyclesOf(files)).toEqual([]);
    expect(cyclesOf(files, { compilerOptions: options })).toEqual([['src/a.service.ts', 'src/b.service.ts']]);
  });

  it('lit les options d’émission héritées par extends', () => {
    const files = {
      'src/a.ts': "import { B } from './b.js';\nexport class A { b?: B }\n",
      'src/b.ts': "import { A } from './a.js';\nexport class B { a?: A }\n",
    };
    const base = { 'tsconfig.base.json': JSON.stringify({ compilerOptions: { verbatimModuleSyntax: true } }) };
    expect(cyclesOf(files)).toEqual([]);
    expect(cyclesOf(files, { extends: './tsconfig.base.json' }, base)).toEqual([['src/a.ts', 'src/b.ts']]);
  });
});

describe('matchesAliasPattern', () => {
  it('gère les motifs avec et sans étoile', () => {
    expect(matchesAliasPattern('@app/*', '@app/core/logger')).toBe(true);
    expect(matchesAliasPattern('@app/*', '@other/core')).toBe(false);
    expect(matchesAliasPattern('@app', '@app')).toBe(true);
    expect(matchesAliasPattern('@app', '@app/core')).toBe(false);
    expect(matchesAliasPattern('#core/*', '#core/logger')).toBe(true);
  });
});

describe('readManifest', () => {
  it('collecte les quatre sections de dépendances, les subpaths et les alias', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({
        dependencies: { 'ts-morph': '28.0.0' },
        devDependencies: { vitest: '4.1.11' },
        peerDependencies: { typescript: '7.0.2' },
        optionalDependencies: { fsevents: '2.3.3' },
        imports: { '#core/*': './src/core/*.js' },
      }),
      'tsconfig.json': '{\n  // avec un commentaire\n  "compilerOptions": { "paths": { "@app/*": ["./src/*"] } }\n}',
    });
    const manifest = readManifest(root);
    expect(manifest.trustworthy).toBe(true);
    expect([...manifest.dependencies].sort())
      .toEqual(['fsevents', 'ts-morph', 'typescript', 'vitest']);
    expect(manifest.subpathImports).toEqual(['#core/*']);
    expect(manifest.pathAliases).toEqual(['@app/*']);
  });

  it('suit la chaîne extends pour les options d’émission et les alias', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ dependencies: {} }),
      'tsconfig.base.json': JSON.stringify({
        compilerOptions: {
          verbatimModuleSyntax: true,
          emitDecoratorMetadata: true,
          baseUrl: '.',
          paths: { '@app/*': ['./src/*'] },
        },
      }),
      'tsconfig.json': JSON.stringify({ extends: './tsconfig.base.json' }),
    });
    const manifest = readManifest(root);
    expect(manifest.trustworthy).toBe(true);
    expect(manifest.verbatimModuleSyntax).toBe(true);
    expect(manifest.emitDecoratorMetadata).toBe(true);
    expect(manifest.pathAliases).toEqual(['@app/*']);
    expect(manifest.baseUrl).toBe('');
  });

  it('reste fiable sur un tsconfig bancal : extends introuvable, cible d’alias mal formée', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ dependencies: {} }),
      'tsconfig.json': JSON.stringify({
        extends: './nulle-part.json',
        compilerOptions: { paths: { '@bad/*': 'pas-un-tableau', '@app/*': ['./src/*'] } },
      }),
    });
    const manifest = readManifest(root);
    expect(manifest.trustworthy).toBe(true);
    expect(manifest.pathAliases).toEqual(['@bad/*', '@app/*']);
    expect(manifest.pathMappings).toEqual([{ pattern: '@app/*', targets: ['./src/*'] }]);
  });

  it('se déclare non fiable sans package.json', () => {
    const manifest = readManifest(makeRoot({ 'README.md': 'vide' }));
    expect(manifest.trustworthy).toBe(false);
    expect(manifest.untrustworthyReason).toMatch(/package\.json/);
  });

  it('se déclare non fiable sur un tsconfig illisible', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ dependencies: {} }),
      'tsconfig.json': '{ this is not json',
    });
    const manifest = readManifest(root);
    expect(manifest.trustworthy).toBe(false);
    expect(manifest.untrustworthyReason).toMatch(/tsconfig\.json/);
  });

  it('reste fiable sans tsconfig du tout', () => {
    const manifest = readManifest(makeRoot({ 'package.json': JSON.stringify({}) }));
    expect(manifest.trustworthy).toBe(true);
    expect(manifest.pathAliases).toEqual([]);
  });
});

describe('isDeclared', () => {
  const manifest: Manifest = {
    dir: '',
    dependencies: new Set(['ts-morph']),
    subpathImports: ['#core/*'],
    pathAliases: ['@app/*'],
    pathMappings: [{ pattern: '@app/*', targets: ['./src/*'] }],
    baseUrl: '',
    verbatimModuleSyntax: false,
    emitDecoratorMetadata: false,
    trustworthy: true,
  };

  it('accepte dépendance, alias et subpath', () => {
    expect(isDeclared(manifest, 'ts-morph/lib', 'ts-morph')).toBe(true);
    expect(isDeclared(manifest, '@app/core', '@app/core')).toBe(true);
    expect(isDeclared(manifest, '#core/logger', '#core')).toBe(true);
  });

  it('refuse un paquet non déclaré', () => {
    expect(isDeclared(manifest, 'left-pad', 'left-pad')).toBe(false);
  });
});

describe('ambientModulePatterns', () => {
  const base: Manifest = {
    dir: '',
    dependencies: new Set(['racine']),
    subpathImports: [],
    pathAliases: [],
    pathMappings: [],
    baseUrl: '',
    verbatimModuleSyntax: false,
    emitDecoratorMetadata: false,
    trustworthy: true,
  };

  it('suit les dépendances transitives et lit le champ exports', () => {
    const root = makeRoot({
      'node_modules/racine/package.json': '{"name":"racine","dependencies":{"feuille":"1.0.0"}}',
      'node_modules/feuille/package.json': '{"name":"feuille","exports":{".":{"types":"./dist/index.d.ts"}}}',
      'node_modules/feuille/dist/index.d.ts': "declare module '@alias/Chose' {}\n",
    });
    expect(ambientModulePatterns(root, base)).toEqual(['@alias/Chose']);
  });

  it('rend une liste vide quand rien n’est installé', () => {
    expect(ambientModulePatterns(makeRoot({ 'package.json': '{}' }), base)).toEqual([]);
  });

  it('ignore un `declare module` écrit dans un commentaire', () => {
    const root = makeRoot({
      'node_modules/racine/package.json': '{"name":"racine","types":"index.d.ts"}',
      'node_modules/racine/index.d.ts': [
        '/**',
        ' * Exemple d\'utilisation :',
        ' * declare module \'*\';',
        ' */',
        'declare module \'@vrai/Alias\' {}',
      ].join('\n'),
    });
    expect(ambientModulePatterns(root, base)).toEqual(['@vrai/Alias']);
  });

  it('arbitre sur l’AST la forme courte, sans `declare`, valide dans un fichier de déclarations', () => {
    const root = makeRoot({
      'node_modules/racine/package.json': '{"name":"racine","types":"index.d.ts"}',
      'node_modules/racine/index.d.ts': "module '@court/Alias' {}\nconst texte = \"module 'faux/Positif'\";\n",
    });
    expect(ambientModulePatterns(root, base)).toEqual(['@court/Alias']);
  });

  it('écarte un motif qui couvrirait n’importe quel specifier', () => {
    const root = makeRoot({
      'node_modules/racine/package.json': '{"name":"racine","types":"index.d.ts"}',
      'node_modules/racine/index.d.ts': "declare module '*';\ndeclare module '*.svg';\ndeclare module '@theme/*';\n",
    });
    expect(ambientModulePatterns(root, base)).toEqual(['*.svg', '@theme/*']);
  });

  it('garde la règle critique vivante malgré un `declare module *` publié par une dépendance', () => {
    const root = makeRoot({
      'package.json': '{"dependencies":{"racine":"1.0.0"}}',
      'node_modules/racine/package.json': '{"name":"racine","types":"index.d.ts"}',
      'node_modules/racine/index.d.ts': "declare module '*';\n",
      'src/a.ts': '',
    });
    const governing = { ...base, dependencies: new Set(['racine']) };
    const findings = importFindings(
      { rootPath: root, manifestFor: () => governing, isRuntimeImport: () => true, resolvesSpecifier: specifierResolver(root) },
      new Map([['src/a.ts', [{ specifier: 'paquet-invente', specifierKind: 'bare' as const, kind: 'import' as const, line: 1 }]]]),
    );
    expect(findings.map((finding) => [finding.rule, finding.symbol]))
      .toEqual([['unknown-dependency', 'paquet-invente']]);
  });
});

describe('importFindings', () => {
  const manifest: Manifest = {
    dir: '',
    dependencies: new Set(['ts-morph']),
    subpathImports: [],
    pathAliases: [],
    pathMappings: [],
    baseUrl: '',
    verbatimModuleSyntax: false,
    emitDecoratorMetadata: false,
    trustworthy: true,
  };

  function context(rootPath: string, governing: Manifest = manifest): DependencyContext {
    return {
      rootPath,
      manifestFor: () => governing,
      isRuntimeImport: () => true,
      resolvesSpecifier: specifierResolver(rootPath),
    };
  }

  function refs(...entries: Array<[string, ImportRef['specifierKind']]>): ImportRef[] {
    return entries.map(([specifier, specifierKind], index) => ({
      specifier,
      specifierKind,
      kind: 'import' as const,
      line: index + 1,
    }));
  }

  it('signale en critique un paquet absent du package.json et de node_modules', () => {
    const findings = importFindings(
      context('/nowhere'),
      new Map([['src/a.ts', refs(['left-pad', 'bare'])]]),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      tool: 'imports',
      rule: 'unknown-dependency',
      file: 'src/a.ts',
      symbol: 'left-pad',
      severity: 'critical',
      line: 1,
    });
  });

  it('signale en majeur, une seule fois, un paquet installé mais non déclaré', () => {
    const root = makeRoot({ 'node_modules/express/package.json': '{}', 'src/a.ts': '' });
    const findings = importFindings(
      context(root),
      new Map([['src/a.ts', refs(['express', 'bare'], ['left-pad', 'bare'])]]),
    );
    expect(findings.map((finding) => [finding.rule, finding.symbol, finding.severity])).toEqual([
      ['unknown-dependency', 'left-pad', 'critical'],
      ['unlisted-dependency', 'express', 'major'],
    ]);
  });

  it('ignore un import de types seuls couvert par un @types déclaré, pas un import utilisé comme valeur', () => {
    const withTypes = { ...manifest, dependencies: new Set(['@types/express']) };
    const typeOnly = importFindings(
      { ...context('/nowhere', withTypes), isRuntimeImport: () => false },
      new Map([['src/a.ts', refs(['express', 'bare'])]]),
    );
    expect(typeOnly).toEqual([]);
    const asValue = importFindings(context('/nowhere', withTypes), new Map([['src/a.ts', refs(['express', 'bare'])]]));
    expect(asValue[0]).toMatchObject({ rule: 'unknown-dependency', symbol: 'express' });
  });

  it('ne prend un @types installé pour le paquet que si l’import ne sert qu’aux types', () => {
    const root = makeRoot({ 'node_modules/@types/express/package.json': '{}', 'src/a.ts': '' });
    const imports = new Map([['src/a.ts', refs(['express', 'bare'])]]);
    expect(importFindings(context(root), imports)[0])
      .toMatchObject({ rule: 'unknown-dependency', severity: 'critical' });
    expect(importFindings({ ...context(root), isRuntimeImport: () => false }, imports)[0])
      .toMatchObject({ rule: 'unlisted-dependency', severity: 'major' });
  });

  it('laisse passer dépendance déclarée, module natif et chemin absolu', () => {
    const findings = importFindings(
      context('/nowhere'),
      new Map([['src/a.ts', refs(['ts-morph', 'bare'], ['node:fs', 'builtin'], ['/abs', 'absolute'])]]),
    );
    expect(findings).toEqual([]);
  });

  it('se tait sur un alias de framework déclaré en ambiant par un paquet installé', () => {
    // Cas Docusaurus : '@theme/Heading' n'est pas un paquet npm, il est déclaré par le thème,
    // que le site n'installe que par son preset.
    const root = makeRoot({
      'package.json': '{"dependencies":{"preset":"1.0.0"}}',
      'node_modules/preset/package.json': '{"name":"preset","dependencies":{"theme":"1.0.0"}}',
      'node_modules/theme/package.json': '{"name":"theme","types":"theme.d.ts"}',
      'node_modules/theme/theme.d.ts': "declare module '@theme/Heading' { const H: unknown; export default H; }\n"
        + "declare module '@theme-original/*';\n",
      'src/a.ts': '',
    });
    const governing = { ...manifest, dependencies: new Set(['preset']) };
    const findings = importFindings(
      context(root, governing),
      new Map([['src/a.ts', refs(['@theme/Heading', 'bare'], ['@theme-original/Footer', 'bare'], ['left-pad', 'bare'])]]),
    );
    expect(findings.map((finding) => finding.symbol)).toEqual(['left-pad']);
  });

  it('se tait entièrement quand le manifeste n’est pas fiable', () => {
    const findings = importFindings(
      context('/nowhere', { ...manifest, trustworthy: false, untrustworthyReason: 'package.json introuvable' }),
      new Map([['src/a.ts', refs(['left-pad', 'bare'])]]),
    );
    expect(findings).toEqual([]);
  });

  it('signale un import relatif qui ne mène nulle part', () => {
    const root = makeRoot({ 'package.json': '{}', 'src/a.ts': '' });
    const findings = importFindings(
      context(root),
      new Map([['src/a.ts', refs(['./fantome.js', 'relative'])]]),
    );
    expect(findings[0]).toMatchObject({ rule: 'unresolved-import', symbol: './fantome.js' });
  });

  it('accepte un import relatif hors scope mais présent sur le disque', () => {
    const root = makeRoot({
      'package.json': '{}',
      'src/a.ts': '',
      'src/data.json': '{}',
      'src/generated.ts': '',
    });
    const findings = importFindings(
      context(root),
      new Map([['src/a.ts', refs(['./data.json', 'relative'], ['./generated.js', 'relative'])]]),
    );
    expect(findings).toEqual([]);
  });

  it('garde le même id quand l’import change de ligne', () => {
    const one = importFindings(
      context('/nowhere'),
      new Map([['src/a.ts', refs(['left-pad', 'bare'])]]),
    );
    const two = importFindings(
      context('/nowhere'),
      new Map([['src/a.ts', [{ specifier: 'left-pad', specifierKind: 'bare', kind: 'import', line: 42 }]]]),
    );
    expect(two[0]?.id).toBe(one[0]?.id);
  });
});

describe('runtimeImports', () => {
  it('efface un import utilisé seulement comme type, garde un import utilisé comme valeur', () => {
    const sources = makeProject({
      'src/a.ts': [
        "import type { Request } from 'express';",
        "import { Response } from 'koa';",
        "import { Router } from 'fastify';",
        'export const router = Router();',
        'export function handle(req: Request, res: Response): void { void req; void res; }',
      ].join('\n'),
    });
    expect([...runtimeImports(sources.get('src/a.ts') as SourceFile)]).toEqual(['fastify']);
  });

  it('avec verbatimModuleSyntax, n’efface que les imports marqués import type', () => {
    const sources = makeProject({
      'src/a.ts': [
        "import type { A } from 'erased';",
        "import { type B } from 'inline';",
        "import { C } from 'typed';",
        'export function f(a: A, b: B, c: C): void { void a; void b; void c; }',
      ].join('\n'),
    });
    const emit = { verbatimModuleSyntax: true, emitDecoratorMetadata: false };
    expect([...runtimeImports(sources.get('src/a.ts') as SourceFile, emit)].sort()).toEqual(['inline', 'typed']);
  });

  it('avec emitDecoratorMetadata, garde le type d’un paramètre de constructeur décoré', () => {
    const sources = makeProject({
      'src/a.service.ts': [
        "import { Injectable } from '@nestjs/common';",
        "import { BService } from './b.service.js';",
        '@Injectable()',
        'export class AService { constructor(private readonly b: BService) {} }',
      ].join('\n'),
    });
    const source = sources.get('src/a.service.ts') as SourceFile;
    const emit = { verbatimModuleSyntax: false, emitDecoratorMetadata: true };
    expect([...runtimeImports(source)].sort()).toEqual(['@nestjs/common']);
    expect([...runtimeImports(source, emit)].sort()).toEqual(['./b.service.js', '@nestjs/common']);
  });
});

describe('analyzeImports', () => {
  it('assemble rapport, graphe et résumé', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ dependencies: { 'ts-morph': '28.0.0' } }),
      'src/a.ts': '',
      'src/b.ts': '',
    });
    const sources = makeProject({
      'src/a.ts': ["import { b } from './b.js';", "import { Project } from 'ts-morph';", "import 'left-pad';", 'void b; void Project;'].join('\n'),
      'src/b.ts': 'export const b = 1;\n',
    });
    const { report, graph } = analyzeImports(root, sources);
    expect(report.manifestTrusted).toBe(true);
    expect(report.summary).toEqual({
      filesScanned: 2,
      internalEdges: 1,
      externalPackages: 2,
      unknownDependencies: 1,
      unresolvedImports: 0,
    });
    expect(report.findings.map((finding) => finding.symbol)).toEqual(['left-pad']);
    expect(areLinked(graph, 'src/a.ts', 'src/b.ts')).toBe(true);
  });

  it('juge un sous-dossier contre son propre package.json', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ dependencies: { 'root-only': '1.0.0' } }),
      'node_modules/root-only/package.json': '{}',
      'sub/package.json': JSON.stringify({ dependencies: { 'sub-only': '1.0.0' } }),
      'sub/node_modules/sub-only/package.json': '{}',
      'sub/src/main.ts': '',
    });
    const sources = makeProject({ 'sub/src/main.ts': "import 'sub-only';\nimport 'root-only';\n" });
    const { report } = analyzeImports(root, sources);
    expect(report.findings.map((finding) => [finding.rule, finding.symbol, finding.message])).toEqual([
      ['unlisted-dependency', 'root-only', "paquet 'root-only' installé mais absent de sub/package.json"],
    ]);
  });

  it('désactive la règle et explique pourquoi sans package.json', () => {
    const root = makeRoot({ 'src/a.ts': '' });
    const sources = makeProject({ 'src/a.ts': "import 'left-pad';\n" });
    const { report } = analyzeImports(root, sources);
    expect(report.manifestTrusted).toBe(false);
    expect(report.manifestReason).toMatch(/package\.json/);
    expect(report.findings).toEqual([]);
  });
});
