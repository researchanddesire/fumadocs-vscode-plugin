'use client';

import { useEffect } from 'react';

/** Message the parent webview sends to scroll a source line into view. */
interface ScrollToLineMessage {
  type: 'fumadocs:scrollToLine';
  line: number;
}

/** A scroll position expressed as a source line plus a pixel offset from the
 *  top of the scroll viewport — robust to content reflow across reloads. */
interface ScrollAnchor {
  line: number;
  offset: number;
}

interface RestoreScrollMessage {
  type: 'fumadocs:restoreScroll';
  anchor: ScrollAnchor;
}

const isScrollToLineMessage = (data: unknown): data is ScrollToLineMessage =>
  typeof data === 'object' &&
  data !== null &&
  (data as { type?: unknown }).type === 'fumadocs:scrollToLine' &&
  typeof (data as { line?: unknown }).line === 'number';

const isRestoreScrollMessage = (data: unknown): data is RestoreScrollMessage =>
  typeof data === 'object' &&
  data !== null &&
  (data as { type?: unknown }).type === 'fumadocs:restoreScroll' &&
  typeof (data as { anchor?: { line?: unknown } }).anchor?.line === 'number';

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
 * The element that actually scrolls the article content — the nearest
 * scrollable ancestor of the rendered body, or the document otherwise.
 */
const getScroller = (): Element => {
  const probe = document.querySelector('[data-source-line]');
  let node = probe?.parentElement ?? null;
  while (node && node !== document.body) {
    const overflowY = getComputedStyle(node).overflowY;
    if (
      (overflowY === 'auto' || overflowY === 'scroll') &&
      node.scrollHeight > node.clientHeight + 1
    ) {
      return node;
    }
    node = node.parentElement;
  }
  return document.scrollingElement ?? document.documentElement;
};

/** Top of the scroller's viewport in client coordinates (0 for the document). */
const scrollerViewportTop = (scroller: Element): number =>
  scroller === document.scrollingElement || scroller === document.documentElement
    ? 0
    : scroller.getBoundingClientRect().top;

/** Snapshot the first source-mapped element in view + its offset from the top. */
const captureAnchor = (): ScrollAnchor | null => {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>('[data-source-line]'),
  );
  if (nodes.length === 0) return null;
  const viewportTop = scrollerViewportTop(getScroller());

  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.bottom > viewportTop + 1) {
      const line = Number(node.dataset.sourceLine);
      if (Number.isNaN(line)) continue;
      return { line, offset: rect.top - viewportTop };
    }
  }
  return null;
};

/** Scroll so the anchored line sits back at its previous viewport offset. */
const restoreAnchor = (anchor: ScrollAnchor): void => {
  const target = findTarget(anchor.line);
  if (!target) return;
  const scroller = getScroller();
  const viewportTop = scrollerViewportTop(scroller);
  const delta = target.getBoundingClientRect().top - viewportTop - anchor.offset;
  if (Math.abs(delta) < 1) return;
  scroller.scrollTop += delta;
};

/**
 * Bridges the editor and the preview:
 *  - scrolls the matching source line into view on cursor moves, and
 *  - reports/restores a scroll anchor so live-reloads keep your place.
 * Renders nothing.
 */
export function ScrollSync() {
  useEffect(() => {
    const scrollToLine = (line: number): void => {
      const target = findTarget(line);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
    };

    let anchorTimer: ReturnType<typeof setTimeout> | undefined;
    const reportAnchor = (): void => {
      if (anchorTimer) clearTimeout(anchorTimer);
      anchorTimer = setTimeout(() => {
        const anchor = captureAnchor();
        if (anchor) {
          window.parent?.postMessage({ type: 'fumadocs:anchor', anchor }, '*');
        }
      }, 150);
    };

    const handleMessage = (event: MessageEvent): void => {
      if (isScrollToLineMessage(event.data)) {
        scrollToLine(event.data.line);
      } else if (isRestoreScrollMessage(event.data)) {
        // Re-apply across a couple of frames: code highlighting and fonts can
        // shift layout slightly after the initial paint.
        const { anchor } = event.data;
        restoreAnchor(anchor);
        requestAnimationFrame(() => restoreAnchor(anchor));
        setTimeout(() => restoreAnchor(anchor), 250);
      }
    };

    window.addEventListener('message', handleMessage);
    // Capture-phase so scrolls from inner scroll containers are seen too.
    window.addEventListener('scroll', reportAnchor, true);
    // Tell the host we're mounted so it can replay the pending cursor line or
    // restore the previous scroll position right after a reload.
    window.parent?.postMessage({ type: 'fumadocs:ready' }, '*');

    return () => {
      window.removeEventListener('message', handleMessage);
      window.removeEventListener('scroll', reportAnchor, true);
      if (anchorTimer) clearTimeout(anchorTimer);
    };
  }, []);

  return null;
}
