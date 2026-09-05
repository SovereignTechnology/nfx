import type { Decorator, Preview } from '@storybook/react-vite';
import type { ReactElement } from 'react';
import '../src/tokens/tokens.css';
import '../src/components/components.css';
import './preview.css';

/**
 * `theme` global: sets `data-theme` on <html>, exactly what the Settings toggle does in the
 * shells (tokens/theme.ts `applyTheme`). `system` removes the attribute so
 * `prefers-color-scheme` decides. The screenshot script passes `globals=theme:dark` etc.
 */
const preview: Preview = {
  globalTypes: {
    theme: {
      description: 'Colour theme',
      toolbar: {
        title: 'Theme',
        icon: 'mirror',
        items: [
          { value: 'light', title: 'Light' },
          { value: 'dark', title: 'Dark' },
          { value: 'system', title: 'System' },
        ],
        dynamicTitle: true,
      },
    },
  },
  initialGlobals: { theme: 'light' },
  parameters: {
    layout: 'fullscreen',
    controls: { expanded: false },
  },
  decorators: [
    ((Story, context): ReactElement => {
      const theme = String(context.globals['theme'] ?? 'light');
      const root = document.documentElement;
      if (theme === 'light' || theme === 'dark') root.setAttribute('data-theme', theme);
      else root.removeAttribute('data-theme');
      const width = (context.parameters['nf'] as { width?: number } | undefined)?.width ?? 640;
      return (
        <div className="nf-story" data-nf-story style={{ width }}>
          <Story />
        </div>
      );
    }) satisfies Decorator,
  ],
};

export default preview;
