import { defineConfig, type Plugin } from 'vite';
import path from 'node:path';
import fs from 'node:fs';

function copyStaticFiles(files: { src: string; dest: string }[]): Plugin {
  return {
    name: 'copy-static-files',
    writeBundle(options) {
      const outDir = options.dir || path.dirname(options.file || '');
      for (const { src, dest } of files) {
        const target = path.resolve(outDir, dest);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(src, target);
      }
    },
  };
}

// https://vitejs.dev/config
export default defineConfig({
  resolve: {
    alias: {
      '@shared': path.resolve(__dirname, './src/shared'),
    },
  },
  plugins: [
    copyStaticFiles([
      { src: 'src/main/splash.html', dest: 'splash.html' },
    ]),
  ],
  build: {
    rollupOptions: {
      external: [
        // Runtime provided by Electron
        'electron',
        // Native modules - MUST be external
        'node-pty',
        '@anthropic-ai/claude-code', // CLI with native ripgrep.node (for OAuth)
        '@anthropic-ai/claude-agent-sdk', // SDK with native ripgrep.node (for query())
      ],
    },
  },
});
