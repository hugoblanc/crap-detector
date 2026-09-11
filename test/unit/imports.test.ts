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
  normalizeRelative,
  packageNameOf,
  resolveRelativeImport,
  runtimeImports,
} from '../../src/imports/extract.js';
import type { ImportRef } from '../../src/imports/extract.js';
import {
  isDeclared,
  matchesAliasPattern,
  readManifest,
  stripJsonComments,
} from '../../src/imports/manifest.js';
import type { Manifest } from '../../src/imports/manifest.js';
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

  it('areLinked est vrai dans les deux sens et faux sur une paire sans arête', () => {
    const graph = buildImportGraph(imports);
    expect(areLinked(graph, 'src/a.ts', 'src/b.ts')).toBe(true);
    expect(areLinked(graph, 'src/b.ts', 'src/a.ts')).toBe(true);
    expect(areLinked(graph, 'src/a.ts', 'src/c.ts')).toBe(false);
  });
});

describe('stripJsonComments', () => {
  it('retire les commentaires de ligne et de bloc', () => {
    const raw = '{\n  // ligne\n  "a": 1, /* bloc */\n  "b": 2\n}';
    expect(JSON.parse(stripJsonComments(raw))).toEqual({ a: 1, b: 2 });
  });

  it('préserve une séquence // à l’intérieur d’une chaîne', () => {
    const raw = '{ "url": "https://example.com", "b": 2 }';
    expect(JSON.parse(stripJsonComments(raw))).toEqual({ url: 'https://example.com', b: 2 });
  });

  it('retire les virgules traînantes', () => {
    expect(JSON.parse(stripJsonComments('{ "a": [1, 2,], }'))).toEqual({ a: [1, 2] });
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

describe('importFindings', () => {
  const manifest: Manifest = {
    dir: '',
    dependencies: new Set(['ts-morph']),
    subpathImports: [],
    pathAliases: [],
    pathMappings: [],
    baseUrl: '',
    trustworthy: true,
  };

  function context(rootPath: string, governing: Manifest = manifest): DependencyContext {
    return { rootPath, manifestFor: () => governing, isRuntimeImport: () => true };
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

  it('laisse passer dépendance déclarée, module natif et chemin absolu', () => {
    const findings = importFindings(
      context('/nowhere'),
      new Map([['src/a.ts', refs(['ts-morph', 'bare'], ['node:fs', 'builtin'], ['/abs', 'absolute'])]]),
    );
    expect(findings).toEqual([]);
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
