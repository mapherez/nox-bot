import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig({ plugins: [react()], server: { host: '127.0.0.1', proxy: { '/auth': 'http://127.0.0.1:3200', '/dashboard/api': 'http://127.0.0.1:3200' } }, build: { sourcemap: false } });
