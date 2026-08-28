# Contributing

Thank you for your interest in Codex Link.

## Development

Use the locked dependency versions and run the existing checks before submitting changes:

```bash
npm install
npm run check
npm test
```

## Pull Requests

- Keep changes focused and describe the user-facing behavior they affect.
- Include tests or verification notes for restore, backup, filesystem, and cross-platform behavior.
- Do not commit local backup data, restore points, credentials, generated installers, screenshots, or QA reports.
- Avoid changing the storage or restore format without documenting migration behavior.

## Release Safety

Restore and rollback behavior is safety-critical. Any change touching file writes, manifests, path adaptation, or rollback journals should include a clear failure-mode explanation and a repeatable verification path.

## License

By contributing to this repository, you agree that your contributions are licensed under the Apache License 2.0.
