import { describe, expect, it } from 'vitest';
import { parseJUnitXml } from '../junit.js';

describe('parseJUnitXml', () => {
  it('parses nested passing and failing tests and decodes entities', () => {
    const parsed = parseJUnitXml(`<?xml version="1.0"?><testsuites><testsuite>
      <testcase classname="tests.test_a" name="test &amp; x"/>
      <testcase classname="tests.test_a" name="test_y"><failure message="no"/></testcase>
    </testsuite></testsuites>`);
    expect(parsed.outcome).toBe('failed');
    expect(parsed.tests).toEqual(new Map([
      ['tests.test_a::test & x', 'passed'],
      ['tests.test_a::test_y', 'failed'],
    ]));
  });

  it('lets failure win duplicate identities and excludes skipped tests', () => {
    const parsed = parseJUnitXml(`<testsuite>
      <testcase classname="c" name="x"/>
      <testcase classname="c" name="x"><failure/></testcase>
      <testcase classname="c" name="skip"><skipped/></testcase>
    </testsuite>`);
    expect(parsed.tests).toEqual(new Map([['c::x', 'failed']]));
  });

  it.each([
    ['', 'empty'],
    ['<testsuite><testcase classname="c" name="x">', 'truncated'],
    ['<testsuite><testcase classname="c" name="ok"/><testcase classname="c" name="broken"></testsuite>', 'partially truncated'],
    ['<testsuite><garbage/><testcase classname="c" name="ok"/></testsuite>', 'unknown element'],
    ['not xml', 'non XML'],
    ['<testsuite><testcase classname="c" name="x"><error/></testcase></testsuite>', 'error child'],
  ])('returns infra_error for %s (%s)', (xml) => {
    expect(parseJUnitXml(xml).outcome).toBe('infra_error');
  });
});
