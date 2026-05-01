import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="font-mono text-[15px]">
          <span className="text-[#FFFC00] [text-shadow:0_0_8px_rgba(255,252,0,0.35)]">snap</span>
          <span>cap</span>
        </span>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
    links: [
      { text: 'Guide', url: '/docs/guide/getting-started' },
      { text: 'Reference', url: '/docs/api' },
      { text: 'Internals', url: '/docs/internals/architecture' },
    ],
  };
}
