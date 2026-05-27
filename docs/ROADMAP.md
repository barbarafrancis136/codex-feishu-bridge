# Roadmap

This document turns the current cloud-first Feishu bridge work into a practical development map.

## Capability Map

### Core bridge

- Feishu/Lark message intake through long connection
- Workspace binding per conversation
- Codex thread create, resume, switch, stop
- Streaming reply cards and completed-state summaries
- Approval cards plus command-based approve/reject flow

### Workspace controls

- `/codex bind /absolute/path`
- `/codex where`
- `/codex workspace`
- `/codex switch <threadId>`
- `/codex new`
- `/codex message`
- `/codex stop`
- `/codex access <default|full-access>`
- `/codex model ...`
- `/codex effort ...`
- `/goal`, `/goal <text>`, `/goal clear`

### Diagnostics and runtime consistency

- `/codex doctor` shows:
  - instance label
  - runtime OS
  - Codex CLI baseline
  - model catalog state
  - workspace reachability
  - attachment cache status
  - verified capability flags
  - plugin root and marketplace counts

### Attachments

- inbound image/file/audio download
- image handoff as `localImage`
- attachment cache retention support
- cloud Snap-compatible cache path fallback
- daily cleanup automation for cloud retention

### Skills and plugins

- cloud skill root browsing
- plugin root browsing
- plugin skeleton creation
- GitHub plugin bootstrap install
- plugin manifest generation
- marketplace entry generation

### Extension points

- external runtime extension hook
- custom Codex profile switching
- third-party provider / endpoint support through runtime environment

## Current Gaps

### P0 gaps

- Plugin installation is still bootstrap-oriented, not a full package manager.
- `/codex plugin list` is now clearer, but there is no install/upgrade/remove lifecycle yet.
- GitHub and Canva capability flags are environment-declared, not fully self-probed.
- Chrome remains gated by runtime support and should stay explicitly separated.

### P1 gaps

- No dedicated plugin uninstall command
- No plugin version upgrade flow
- No plugin validation command
- No marketplace search or remote source install
- Help and status surfaces do not yet show per-plugin detailed health

### P2 gaps

- No graphical admin surface outside Feishu cards
- No multi-marketplace source management
- No cloud-side browser verification workflow built into doctor
- No plugin permission model beyond what Codex runtime already enforces

## Prioritized Roadmap

### P0: Environment and execution closure

Goal: make the cloud Feishu bot reliably usable every day.

- Keep Codex CLI baseline healthy
- Keep workspace reachability diagnostics explicit
- Keep attachment cache visible and auto-cleaned
- Keep `/goal` persistent and excluded from Mem0 command traffic
- Keep plugin root and marketplace visibility inside doctor/help

### P1: Plugin installation closure

Goal: move from "plugin framework exists" to "plugins are operational".

- Add `/codex plugin install <source>` expansion beyond GitHub bootstrap
- Add `/codex plugin remove <name>`
- Add `/codex plugin validate <name>`
- Persist richer plugin status for cards and doctor
- Improve install feedback with manifest, source, and marketplace linkage

### P2: Marketplace usability

Goal: make plugin discovery manageable for cloud-only bot usage.

- Local marketplace index management
- Search and filter installed vs available plugins
- Source metadata for local, GitHub, and curated bundles
- Upgrade detection and version comparison

### P3: Verified advanced capabilities

Goal: expose only capabilities that are truly runnable in the cloud instance.

- Real GitHub workflow verification
- Real Canva workflow verification
- Browser/Chrome gate with explicit pass/fail checks
- Optional knowledge and memory extensions with clear boundaries

## Recommended Next Implementation Order

1. Add plugin remove and validate commands
2. Add richer plugin status to `/codex doctor`
3. Add real GitHub capability verification path
4. Add Canva verification path
5. Add marketplace search/install source expansion
6. Gate Chrome with explicit verification instead of config-only flagging

## Cloud-First Principle

For this project, "supported" means "verified on the cloud Feishu bot instance", not merely "code exists in the repo".

That principle should continue to drive:

- help text
- doctor output
- release checks
- deployment sign-off
