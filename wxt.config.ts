import { defineConfig } from 'wxt';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Spotify Light Mode',
    description: 'Forces the Spotify web player to use a light color scheme.',
    version: '0.1.0',
    permissions: ['storage'],
  },
});
