# Development

- Use the Node.js version from `.nvmrc`. Verify `npm run check` on the CI versions before submitting changes.
- Keep the core generic and dependency-free at runtime. Use native binary pages.
- Callers must supply conforming typed inputs and keep them immutable until each request or build settles. Storage adapters must return the requested bytes from the immutable generation.
- Do not add database drivers, application-specific schemas, a queue, or a distributed lock to this package.
- Preserve the format, ranking, result order and measured search performance unless a deliberate format change is reviewed.
- Prefer direct loops and readable checks over extra passes, nested transformations and speculative validation.
- Use generated, non-sensitive benchmark fixtures only.
- Changes go through a feature branch and a PR into premaster. Do not merge or publish without owner approval.
