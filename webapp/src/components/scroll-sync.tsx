'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

/** Message the parent webview sends to scroll a source line into view. */
interface ScrollToLineMessage {
  type: 'fumadocs:scrollToLine';
  line: number;
}

/** Message the parent webview sends to soft-refresh the page in place. */
interface RefreshMessage {
  type: 'fumadocs:refresh';
}

const isScrollToLineMessage = (data: unknown): data is ScrollToLineMessage =>
  typeof data === 'object' &&
  data !== null &&
  (data as { type?: unknown }).type === 'fumadocs:scrollToLine' &&
  typeof (data as { line?: unknown }).line === 'number';

const isRefreshMessage = (data: unknown): data is RefreshMessage =>
  typeof data === 'object' &&
  data !== null &&
  (data as { type?: unknown }).type === 'fumadocs:refresh';

/**
 * Find the element whose `data-source-line` is the closest at-or-before the
 * target line, falling back to the first element after it.
 */
const findTarget = (line: number): HTMLElement | null => {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>('[data-source-line]'),
  );
  if (nodes.length === 0) return null;

  let best: HTMLElement | null = null;
  let bestLine = -Infinity;
  let after: HTMLElement | null = null;
  let afterLine = Infinity;

  for (const node of nodes) {
    const nodeLine = Number(node.dataset.sourceLine);
    if (Number.isNaN(nodeLine)) continue;
    if (nodeLine <= line && nodeLine > bestLine) {
      best = node;
      bestLine = nodeLine;
    }
    if (nodeLine > line && nodeLine < afterLine) {
      after = node;
      afterLine = nodeLine;
    }
  }

  return best ?? after;
};

/**
 * Bridges the editor and the preview:
 *  - scrolls the matching source line into view on cursor moves, and
 *  - soft-refreshes the page in place (preserving scroll) on content changes.
 * Renders nothing.
 */
export function ScrollSync() {
  const router = useRouter();

  useEffect(() => {
    const scrollToLine = (line: number): void => {
      const target = findTarget(line);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    const handleMessage = (event: MessageEvent): void => {
      if (isScrollToLineMessage(event.data)) {
        scrollToLine(event.data.line);
      } else if (isRefreshMessage(event.data)) {
        // Re-run the force-dynamic server render in place. React reconciles the
        // DOM, so scroll position and focus are preserved — no full reload.
        router.refresh();
      }
    };

    window.addEventListener('message', handleMessage);
    // Tell the host we're mounted so it can replay the pending cursor line
    // right after a navigation.
    window.parent?.postMessage({ type: 'fumadocs:ready' }, '*');

    return () => {
      window.removeEventListener('message', handleMessage);
    };
  }, [router]);

  return null;
}
