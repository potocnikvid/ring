import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // three.js is most of the bundle (~150 kB gzipped); nothing to gain from splitting it.
    chunkSizeWarningLimit: 700,
  },
});
