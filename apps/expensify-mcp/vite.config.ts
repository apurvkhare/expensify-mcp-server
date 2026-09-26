/**
 * Builds the MCP App view (ui/) into one self-contained dist/mcp-app.html.
 * The host renders it in a sandboxed iframe with no network, so script and
 * styles must be inlined: that is what vite-plugin-singlefile does.
 */
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

export default defineConfig({
  root: 'ui',
  plugins: [react(), viteSingleFile()],
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: { input: fileURLToPath(new URL('./ui/mcp-app.html', import.meta.url)) }
  }
});
