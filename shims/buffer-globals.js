// shims/buffer-globals.js
import { Buffer as BufferPolyfill } from 'buffer';

if (typeof globalThis !== 'undefined') {
  if (!globalThis.Buffer) globalThis.Buffer = BufferPolyfill;
  if (!globalThis.process) globalThis.process = { env: {} };
  if (!globalThis.global)  globalThis.global  = globalThis; // node-style global
}
