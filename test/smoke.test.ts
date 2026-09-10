import { describe, expect, it } from 'vitest';
import { Project } from 'ts-morph';

describe('scaffold', () => {
  it('parses TypeScript with ts-morph on this toolchain', () => {
    const project = new Project({ useInMemoryFileSystem: true });
    const source = project.createSourceFile(
      'probe.ts',
      ['export function add(a: number, b: number): number {', '  return a + b;', '}', ''].join('\n'),
    );
    const fn = source.getFunction('add');
    expect(fn).toBeDefined();
    expect(fn?.getParameters().length).toBe(2);
    expect(source.getFullText()).toContain('return a + b;');
  });

  it('runs on Node >= 22', () => {
    const [majorRaw] = process.versions.node.split('.');
    expect(Number(majorRaw)).toBeGreaterThanOrEqual(22);
  });
});
