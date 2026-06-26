import defaultMdxComponents from 'fumadocs-ui/mdx';
import type { MDXComponents } from 'mdx/types';
import type { ImgHTMLAttributes } from 'react';
import { Accordion, Accordions } from 'fumadocs-ui/components/accordion';
import { Tab, Tabs } from 'fumadocs-ui/components/tabs';
import { Step, Steps } from 'fumadocs-ui/components/steps';
import { Callout } from 'fumadocs-ui/components/callout';
import { Card, Cards } from 'fumadocs-ui/components/card';
import { TypeTable } from 'fumadocs-ui/components/type-table';
import { File, Files, Folder } from 'fumadocs-ui/components/files';
import { Banner } from 'fumadocs-ui/components/banner';
import { InlineTOC } from 'fumadocs-ui/components/inline-toc';

/**
 * Render images as plain `<img>` rather than Fumadocs' `next/image` wrapper.
 *
 * Previewed content rarely declares `width`/`height`, which `next/image`
 * requires (and would otherwise throw on at runtime). `src`s have already been
 * rewritten to the preview image route by `rehypeResolveImages`.
 */
function PreviewImage({
  className,
  ...props
}: Readonly<ImgHTMLAttributes<HTMLImageElement>>) {
  // eslint-disable-next-line @next/next/no-img-element -- runtime preview images lack dimensions
  return (
    <img
      {...props}
      alt={props.alt ?? ''}
      loading="lazy"
      className={['rounded-lg', className].filter(Boolean).join(' ')}
    />
  );
}

/**
 * Every component a previewed file might reference. Authored `import`
 * statements are stripped before compilation, so these are injected globally
 * to keep arbitrary Fumadocs files rendering.
 */
export function getMDXComponents(components?: MDXComponents): MDXComponents {
  return {
    ...defaultMdxComponents,
    img: PreviewImage,
    Accordion,
    Accordions,
    Tab,
    Tabs,
    Step,
    Steps,
    Callout,
    Card,
    Cards,
    TypeTable,
    File,
    Files,
    Folder,
    Banner,
    InlineTOC,
    ...components,
  };
}
