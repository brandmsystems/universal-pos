import { describe, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import * as React from 'react';

/**
 * react-dom is loaded by Node and requires `react` itself; the app's code gets
 * `react` through Vite. If the two resolve to differently spelled paths -- on
 * Windows, `c:\` beside `C:\`, which Node's module cache keys apart -- there are
 * two Reacts, react-dom renders with one and the hooks read the other, and every
 * render test fails with "Cannot read properties of null (reading 'useState')".
 * vitest.config.ts canonicalises the working directory so that cannot happen.
 */
describe('one React', () => {
  it('the react the app imports is the one react-dom uses', () => {
    const require = createRequire(import.meta.url);
    const reactDomsReact: unknown = require(require.resolve('react', { paths: [require.resolve('react-dom')] }));
    expect(reactDomsReact).toBe((React as { default?: unknown }).default ?? React);
  });
});
