import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Spotify Light Mode',
    description: "Bring light mode to Spotify's web player — always on, or only when your OS is in light mode.",
    version: '0.1.0',
    permissions: ['storage'],
  },
});
