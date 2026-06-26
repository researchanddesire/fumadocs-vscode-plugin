export default function NotFound() {
  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16">
      <h1 className="mb-2 text-lg font-semibold text-fd-foreground">
        Nothing to preview here
      </h1>
      <p className="text-sm text-fd-muted-foreground">
        No Markdown or MDX file matched this route in the current content root.
      </p>
    </div>
  );
}
