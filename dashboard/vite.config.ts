import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// GitHub Pages serves the app under /free-ai-gateway/.
// Override with VITE_BASE_PATH env var when needed (e.g. local preview: VITE_BASE_PATH=/).
export default defineConfig({
  base: process.env.VITE_BASE_PATH || '/free-ai-gateway/',
  plugins: [react()],
});
