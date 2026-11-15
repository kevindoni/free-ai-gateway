# Dashboard — Free AI Gateway admin UI

- Dev: `cd dashboard && npm install && npm run dev` (Vite dev server, defaults to http://localhost:5173).
- Build/preview: `npm run build` then `npm run preview` (serves dist at http://localhost:4173, add `--base /free-ai-gateway/` or set `VITE_BASE_PATH=/` locally).
- Deploy: push to `main` — `.github/workflows/pages.yml` builds `dashboard/dist` and publishes it to GitHub Pages at `/free-ai-gateway/`.
- Gateway URL + optional API key are set in the header (persisted in localStorage; default `http://127.0.0.1:8080`).
