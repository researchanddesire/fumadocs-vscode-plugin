import './global.css';
import { RootProvider } from 'fumadocs-ui/provider/next';
import { DocsLayout } from 'fumadocs-ui/layouts/docs';
import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { Inter } from 'next/font/google';
import { buildSource } from '@/lib/source';
import { getContentRoot } from '@/lib/content-root';
import { getGitRepoName } from '@/lib/git-repo-name';

const inter = Inter({ subsets: ['latin'] });

export const dynamic = 'force-dynamic';

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const source = buildSource();
  const siteTitle =
    getGitRepoName(getContentRoot()) ?? 'Fumadocs Preview';

  const baseOptions: BaseLayoutProps = {
    nav: {
      title: siteTitle,
    },
  };

  return (
    <html lang="en" className={inter.className} suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <RootProvider>
          <DocsLayout tree={source.pageTree} {...baseOptions}>
            {children}
          </DocsLayout>
        </RootProvider>
      </body>
    </html>
  );
}
