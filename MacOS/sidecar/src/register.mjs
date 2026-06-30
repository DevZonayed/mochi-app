// Registers the synchronous resolve + load hooks (esbuild-transpiled TS), then nothing else.
// Used as `node --import ./register.mjs <entry>`.
import { registerHooks } from 'node:module';
import { resolve, load } from './hooks.mjs';
registerHooks({ resolve, load });
