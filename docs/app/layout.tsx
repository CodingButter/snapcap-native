import { Inter } from 'next/font/google';
import { Provider } from '@/components/provider';
import type { Metadata } from 'next';
import './global.css';

const inter = Inter({
  subsets: ['latin'],
});

export const metadata: Metadata = {
  title: {
    default: '@snapcap/native',
    template: '%s · @snapcap/native',
  },
  description:
    'Browser-free Snap client for Node. Native bridge to web.snapchat.com — no Playwright, no Frida, no rooted phone.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
