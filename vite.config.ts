import { defineConfig } from "vite";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  build: {
    outDir: "dist/client",
    emptyOutDir: false,
  },
  server: {
    proxy: {
      "/api": "http://127.0.0.1:3000",
      "/pair": "http://127.0.0.1:3000",
    },
  },
  plugins: [
    VitePWA({
      registerType: "autoUpdate",
      filename: "service-worker.js",
      includeAssets: ["favicon.png", "icons/apple-touch-icon.png"],
      manifest: {
        name: "SiB",
        short_name: "SiB",
        id: "/",
        description: "Naše liste za kupovinu i putovanja",
        lang: "hr",
        start_url: "/shopping",
        scope: "/",
        display: "standalone",
        background_color: "#F3EFF5",
        theme_color: "#454955",
        orientation: "portrait-primary",
        shortcuts: [
          {
            name: "Kupovina",
            short_name: "Kupovina",
            url: "/shopping",
            icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
          },
          {
            name: "Putovanja",
            short_name: "Putovanja",
            url: "/travel",
            icons: [{ src: "/icons/icon-192.png", sizes: "192x192" }],
          },
        ],
        icons: [
          {
            src: "/icons/icon-192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "/icons/icon-512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "/icons/icon-maskable-512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
      },
      workbox: {
        navigateFallback: "/index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/pair\//],
        cleanupOutdatedCaches: true,
        clientsClaim: true,
        skipWaiting: true,
      },
    }),
  ],
});
