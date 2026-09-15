import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const base = process.env.CODEX_BRIDGE_BASE_PATH || "/";

export default defineConfig({
  base,
  plugins: [react(), tailwindcss()],
});
