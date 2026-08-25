import type { Preview } from '@storybook/react';
import '../src/index.css';

/**
 * T-021 — global Storybook decorators/parameters. Loads the real app stylesheet (tokens +
 * Tailwind) so every story renders with the actual design tokens, not ad hoc styling.
 */
const preview: Preview = {
  parameters: {
    layout: 'padded',
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    // T-021 TC-2 / TC-9: fail the story on any axe violation, contrast included.
    a11y: {
      config: {},
      options: {
        runOnly: {
          type: 'tag',
          values: ['wcag2a', 'wcag2aa', 'wcag21aa'],
        },
      },
    },
  },
};

export default preview;
