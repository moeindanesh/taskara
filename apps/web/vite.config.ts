import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, repoRoot, '');
  const host = env.VITE_DEV_HOST || undefined;
  const port = parseOptionalPort(env.VITE_DEV_PORT);

  return {
    envDir: repoRoot,
    plugins: [react()],
    build: {
      rollupOptions: {
        output: {
          manualChunks(id) {
            if (!id.includes('node_modules')) return;
            if (
              id.includes('react-multi-date-picker') ||
              id.includes('react-date-object') ||
              id.includes('react-element-popper')
            ) {
              return 'jalali-date-picker-vendor';
            }
            return 'vendor';
          }
        }
      }
    },
    resolve: {
      alias: {
        '@': fileURLToPath(new URL('./', import.meta.url))
      }
    },
    server: {
      ...(host ? { host } : {}),
      ...(port ? { port } : {})
    },
    preview: {
      ...(host ? { host } : {}),
      ...(port ? { port } : {})
    }
  };
});

function parseOptionalPort(value?: string): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`VITE_DEV_PORT must be a positive integer, received ${value}`);
  }
  return port;
}
