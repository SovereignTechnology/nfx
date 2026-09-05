import { defineMain } from '@storybook/react-vite/node';

// Storybook 10 + Vite 8, no addons: the pinned dependency set has none (docs/lanes/L4.md).
// Both themes are driven by the `theme` global in preview.tsx; the screenshot script
// (scripts/screenshots.ts) iterates index.json × {light, dark}.
export default defineMain({
  stories: ['../src/**/*.stories.tsx'],
  framework: '@storybook/react-vite',
  core: { disableTelemetry: true, disableWhatsNewNotifications: true },
  typescript: { reactDocgen: false },
  viteFinal: (config) => ({
    ...config,
    // The package's own tsconfig excludes stories; nothing here needs a tsconfig.
    define: { ...config.define, 'process.env.NODE_DEBUG': 'false' },
  }),
});
