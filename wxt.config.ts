import { defineConfig } from 'wxt';
import { version } from './package.json';

export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifest: {
    name: 'Spotify Light Mode',
    description: "Bring light mode to Spotify's web player — always on, or only when your OS is in light mode.",
    version,
    permissions: ['storage'],
    browser_specific_settings: {
      gecko: {
        id: 'spotify-light-mode@joaco.io',
        strict_min_version: '109.0',
        data_collection_permissions: {
          required: ['none'],
          optional: [],
        },
      },
    },
  },
});
