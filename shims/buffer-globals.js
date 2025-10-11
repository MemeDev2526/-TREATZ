// shims/buffer-globals.js
import { Buffer as BufferPolyfill } from 'buffer';

(function () {
  const g = typeof globalThis !== 'undefined'
    ? globalThis
    : (typeof window !== 'undefined' ? window : self);

  // Buffer
  if (!g.Buffer) g.Buffer = BufferPolyfill;

  // process
  const existingProc = g.process || {};
  const existingEnv = existingProc.env || {};

  const proc = {
    ...existingProc,
    env: {
      ...existingEnv,
      // esbuild will inline process.env.NODE_ENV at build time if you define it.
      // This runtime default is only for libs that check it at runtime.
      NODE_ENV: existingEnv.NODE_ENV ?? 'production',
    },
    browser: true,
    cwd: () => '/',
    // nextTick polyfill: prefer microtask
    nextTick: existingProc.nextTick || (cb => Promise.resolve().then(cb)),
  };

  g.process = proc;

  // node-style global alias
  if (!g.global) g.global = g;
})();