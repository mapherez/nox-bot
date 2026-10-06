import { mkdir, cp } from 'node:fs/promises';
import { writeBuildInfo } from './build-info.mjs';
await mkdir('dist/assets', { recursive: true });
await cp('src/assets', 'dist/assets', { recursive: true });
await writeBuildInfo();
console.log('Dictionary assets and build metadata copied to dist.');
