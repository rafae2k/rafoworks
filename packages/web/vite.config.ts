import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

// React + Vite. `vite build` emits ./dist, which the worker serves as Static Assets
// (see wrangler.toml). The API it talks to is a separate worker — set VITE_API_BASE
// to point at it (defaults to the local `wrangler dev` port).
export default defineConfig({
  plugins: [react()],
})
