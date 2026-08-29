// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      'dist/*',
      // Vendored third-party source: not ours to restyle, and linting it with
      // the app's React config produces noise rather than signal.
      'scripts/cmd-guard/vendor/*',
    ],
  },
  {
    // The cmd-guard scripts are plain Node CommonJS, not React Native source.
    files: ['scripts/**/*.js'],
    languageOptions: {
      sourceType: 'commonjs',
      globals: { __dirname: 'readonly', __filename: 'readonly', require: 'readonly',
                 module: 'writable', process: 'readonly', console: 'readonly' },
    },
  },
]);
