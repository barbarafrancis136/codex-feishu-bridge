# Release Checklist

Run before publishing or tagging a release.

## 1. Code Health

```sh
npm run check
npm run test:markdown
npm run test:card-content
npm run test:media
npm run test:directives
```

## 2. Security and Packaging

```sh
npm run privacy:scan
npm audit --omit=dev
npm pack --dry-run
```

## 3. Final Gate

```sh
npm run check:release
```

This runs:

- JavaScript syntax checks.
- Privacy scan.
- Production dependency audit.
- `npm pack --dry-run`.

## 4. Manual Checks

- `README.md` links are valid.
- Confirm `README.md` and `docs/使用说明.md` match current behavior.
- Confirm `.env.example` contains placeholders only.
- No secrets in repo history or staged changes.
- `.env` is not tracked.
- Sessions/attachments/log files are not tracked.
- `CHANGELOG.md` includes current release notes.
- `SECURITY.md` reflects current reporting and data handling policy.
- Confirm private extensions are not included in this repository.

## 5. Versioning

Before a public release:

1. Update `package.json` version.
2. Run `npm run check:release`.
3. Commit with a release-oriented message.
4. Tag the release (for example, `v0.1.0`).
5. Push branch and tags.
