import {
  DocsBody,
  DocsDescription,
  DocsPage,
  DocsTitle,
} from 'fumadocs-ui/layouts/docs/page';
import { notFound } from 'next/navigation';
import { buildSource } from '@/lib/source';
import { compiler } from '@/lib/compiler';
import { getMDXComponents } from '@/components/mdx';
import type { PageFileData } from '@/lib/source';

export const dynamic = 'force-dynamic';

export default async function Page({
  params,
}: {
  params: Promise<{ slug?: string[] }>;
}) {
  const { slug } = await params;
  const source = buildSource();
  const page = source.getPage(slug);
  if (!page) notFound();

  const data = page.data as PageFileData;
  const compiled = await compiler.compile({
    source: data.content,
    filePath: data.absolutePath,
  });
  const MdxContent = compiled.body;

  const fm = compiled.frontmatter as { title?: string; description?: string };
  const title = fm.title ?? data.title;
  const description = fm.description ?? data.description;

  return (
    <DocsPage toc={compiled.toc}>
      {title ? <DocsTitle>{title}</DocsTitle> : null}
      {description ? <DocsDescription>{description}</DocsDescription> : null}
      <DocsBody>
        <MdxContent components={getMDXComponents()} />
      </DocsBody>
    </DocsPage>
  );
}
