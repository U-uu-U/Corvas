import { defineConfig, normalizePath, transformWithEsbuild } from 'vite';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const srcRoot = resolve(__dirname, 'src');
const sharedClientModules = new Set(['public-api-error', 'error-redaction']
    .map(name => normalizePath(resolve(__dirname, `shared/${name}.cjs`))));

export default defineConfig({
    root: srcRoot,
    base: './',
    plugins: [{
        name: 'shared-client-commonjs',
        apply: 'serve',
        enforce: 'pre',
        transform(code, id) {
            if (!sharedClientModules.has(normalizePath(id.split('?')[0]))) return null;
            return transformWithEsbuild(code, id, { loader: 'js', format: 'esm', sourcemap: true });
        }
    }],
    build: {
        commonjsOptions: { include: [/node_modules/, /shared[\\/](?:public-api-error|error-redaction)\.cjs$/] },
        outDir: resolve(__dirname, 'dist'),
        emptyOutDir: true,
        rollupOptions: {
            input: {
                index: resolve(srcRoot, 'index.html')
            },
            output: {
                entryFileNames: 'assets/[name]-[hash].js',
                chunkFileNames: 'assets/[name]-[hash].js',
                assetFileNames: 'assets/[name]-[hash][extname]'
            }
        }
    },
    server: {
        host: '127.0.0.1',
        port: 15321,
        strictPort: true
    }
});
