// `__OPSLANE_SDK_VERSION__` is replaced at build/test time by vite `define`.
// `typeof` on an undeclared identifier returns "undefined" rather than throwing,
// so the fallback is safe in any runner that doesn't apply the define.
declare const __OPSLANE_SDK_VERSION__: string;

export const SDK_VERSION: string =
  typeof __OPSLANE_SDK_VERSION__ !== 'undefined' ? __OPSLANE_SDK_VERSION__ : '0.0.0-dev';
