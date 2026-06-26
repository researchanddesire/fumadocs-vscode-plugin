'use client';

export default function PreviewError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16">
      <div className="rounded-xl border border-fd-border bg-fd-card p-6">
        <h1 className="mb-2 text-lg font-semibold text-fd-foreground">
          Could not render this file
        </h1>
        <p className="mb-4 text-sm text-fd-muted-foreground">
          The MDX failed to compile. Note: imports/exports are stripped and
          custom (non-Fumadocs) components are not available in preview.
        </p>
        <pre className="mb-4 overflow-auto rounded-lg bg-fd-secondary p-4 text-xs text-fd-secondary-foreground">
          {error.message}
        </pre>
        <button
          type="button"
          onClick={reset}
          className="rounded-md border border-fd-border px-3 py-1.5 text-sm hover:bg-fd-accent"
        >
          Try again
        </button>
      </div>
    </div>
  );
}
