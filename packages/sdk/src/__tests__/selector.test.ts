import { describe, expect, it } from 'vitest';
import { deriveSelector } from '../selector';

describe('deriveSelector', () => {
  it('prefers data-testid', () => {
    document.body.innerHTML = '<button data-testid="checkout-btn" id="x" class="a b">Buy</button>';
    expect(deriveSelector(document.querySelector('button'))).toBe('[data-testid="checkout-btn"]');
  });

  it('falls back to a stable id', () => {
    document.body.innerHTML = '<button id="checkout">Buy</button>';
    expect(deriveSelector(document.querySelector('button'))).toBe('#checkout');
  });

  it('rejects hash-like ids and falls back to a path', () => {
    document.body.innerHTML = '<div><button id="a1b2c3d4e5f6a1b2c3d4">Buy</button></div>';
    const selector = deriveSelector(document.querySelector('button'));
    expect(selector).not.toContain('a1b2c3d4');
    expect(selector).toContain('button');
  });

  it('builds an nth-of-type path when nothing stable exists', () => {
    document.body.innerHTML = '<div class="wrap"><span>a</span><span>b</span></div>';
    expect(deriveSelector(document.querySelectorAll('span')[1])).toContain('span:nth-of-type(2)');
  });

  it('never includes element text or arbitrary attributes', () => {
    document.body.innerHTML = '<button data-user-email="alice@example.com" data-order="ord_9931">alice@example.com</button>';
    const selector = deriveSelector(document.querySelector('button'));
    expect(selector).not.toContain('alice@example.com');
    expect(selector).not.toContain('ord_9931');
  });

  it('strips dynamic-looking classes', () => {
    document.body.innerHTML = '<div><i class="icon css-1a2b3c4 sc-AxjAm">x</i></div>';
    const selector = deriveSelector(document.querySelector('i'));
    expect(selector).not.toContain('css-1a2b3c4');
    expect(selector).not.toContain('sc-AxjAm');
  });

  it('is bounded in depth and length', () => {
    document.body.innerHTML = `${'<div>'.repeat(51)}<button>x</button>${'</div>'.repeat(51)}`;
    expect(deriveSelector(document.querySelector('button')).length).toBeLessThanOrEqual(256);
  });
});
