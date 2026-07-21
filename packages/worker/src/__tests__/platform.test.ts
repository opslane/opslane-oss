import { afterEach, describe, expect, it } from 'vitest';
import { effectivePlatform, pythonPipelineEnabled } from '../platform.js';

const ORIGINAL = process.env['OPSLANE_PYTHON_PIPELINE'];
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env['OPSLANE_PYTHON_PIPELINE'];
  else process.env['OPSLANE_PYTHON_PIPELINE'] = ORIGINAL;
});

describe('pythonPipelineEnabled', () => {
  it('defaults off', () => {
    delete process.env['OPSLANE_PYTHON_PIPELINE'];
    expect(pythonPipelineEnabled()).toBe(false);
  });
  it.each(['1', 'true', 'TRUE'])('accepts %s', (value) => {
    process.env['OPSLANE_PYTHON_PIPELINE'] = value;
    expect(pythonPipelineEnabled()).toBe(true);
  });
  it.each(['0', 'false', '', 'yes'])('rejects %s', (value) => {
    process.env['OPSLANE_PYTHON_PIPELINE'] = value;
    expect(pythonPipelineEnabled()).toBe(false);
  });
});

describe('effectivePlatform', () => {
  it('routes only enabled Python groups to python', () => {
    expect(effectivePlatform('python', true)).toBe('python');
    expect(effectivePlatform('python', false)).toBe('javascript');
    expect(effectivePlatform(null, true)).toBe('javascript');
    expect(effectivePlatform('ruby', true)).toBe('javascript');
  });
});
