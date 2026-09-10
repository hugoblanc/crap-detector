import { describe, expect, it } from 'vitest';
import {
  compareFindings,
  findingId,
  makeFinding,
  severityForValue,
} from '../../src/core/findings.js';
import type { Finding } from '../../src/core/types.js';

describe('findingId', () => {
  it('is stable when the function moves within the file', () => {
    const before = findingId('metrics', 'cyclomatic-complexity', 'src/a.ts', 'processOrder');
    const after = findingId('metrics', 'cyclomatic-complexity', 'src/a.ts', 'processOrder');
    expect(after).toBe(before);
  });

  it('changes when tool, rule, file or symbol change', () => {
    const base = findingId('metrics', 'cyclomatic-complexity', 'src/a.ts', 'f');
    expect(findingId('knip', 'cyclomatic-complexity', 'src/a.ts', 'f')).not.toBe(base);
    expect(findingId('metrics', 'cognitive-complexity', 'src/a.ts', 'f')).not.toBe(base);
    expect(findingId('metrics', 'cyclomatic-complexity', 'src/b.ts', 'f')).not.toBe(base);
    expect(findingId('metrics', 'cyclomatic-complexity', 'src/a.ts', 'g')).not.toBe(base);
  });

  it('is a 12-char hex string', () => {
    expect(findingId('metrics', 'r', 'f.ts', 's')).toMatch(/^[0-9a-f]{12}$/);
  });
});

describe('makeFinding severity', () => {
  it('derives severity from distance to threshold', () => {
    expect(severityForValue(10, 10)).toBe('minor');
    expect(severityForValue(12, 10)).toBe('minor');
    expect(severityForValue(13, 10)).toBe('major');
    expect(severityForValue(21, 10)).toBe('critical');
  });

  it('carries value and threshold onto the finding', () => {
    const finding = makeFinding({
      tool: 'metrics',
      rule: 'cyclomatic-complexity',
      file: 'src/a.ts',
      symbol: 'bigFn',
      line: 12,
      value: 21,
      threshold: 10,
      message: 'CC 21 > 10',
    });
    expect(finding.id).toMatch(/^[0-9a-f]{12}$/);
    expect(finding.severity).toBe('critical');
    expect(finding.value).toBe(21);
    expect(finding.threshold).toBe(10);
  });

  it('falls back to major when there is no comparable threshold', () => {
    const finding = makeFinding({
      tool: 'knip',
      rule: 'unused-export',
      file: 'src/a.ts',
      symbol: 'deadThing',
      message: 'export inutilisé',
    });
    expect(finding.severity).toBe('major');
    expect(finding.threshold).toBeUndefined();
  });
});

describe('compareFindings', () => {
  const f = (
    id: string,
    severity: Finding['severity'],
    ratio: number,
  ): Finding => ({
    id,
    tool: 'metrics',
    rule: 'r',
    severity,
    file: 'a.ts',
    ...(ratio === 0 ? {} : { value: ratio * 10, threshold: 10 }),
    message: '',
  });

  it('sorts by severity first', () => {
    const minorHighRatio = f('m1', 'minor', 1.2);
    const majorLowRatio = f('maj1', 'major', 1.05);
    expect(compareFindings(majorLowRatio, minorHighRatio)).toBeLessThan(0);
    expect(compareFindings(minorHighRatio, majorLowRatio)).toBeGreaterThan(0);
  });

  it('sorts equal severities by value/threshold ratio descending', () => {
    const critical25 = f('c1', 'critical', 2.5);
    const critical15 = f('c2', 'critical', 1.5);
    expect(compareFindings(critical25, critical15)).toBeLessThan(0);
  });

  it('breaks ties deterministically and antisymmetrically by id', () => {
    const a = f('aaa', 'info', 0);
    const b = f('bbb', 'info', 0);
    expect(compareFindings(a, b)).toBeLessThan(0);
    expect(compareFindings(a, b)).toBe(-compareFindings(b, a));
  });
});
