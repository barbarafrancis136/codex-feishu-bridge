# Changelog

## v0.2.3 - 2026-04-29

### Changed

- Improved Feishu/Lark streaming card rendering for completed replies.
- Separated final answer content from execution/process content so card bodies stay easier to read.
- Added generic attachment routing for `/codex send`: images are sent as image messages, supported audio as audio messages, and other files as file messages.

### Added

- Added public card-content regression tests for completed reply rendering.
- Added assistant Markdown regression tests for lists, code blocks, inline code, and paragraph handling.
- Added release-time verification through `npm run check:release`.

### Verification

- `npm run check:release` passed locally.
- GitHub Actions passed for commit `c8a9c6d`.
- Privacy scan passed; this public release does not include private runtime extensions, local workspace paths, personal memory bridges, or private automation code.
