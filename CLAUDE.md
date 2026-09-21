# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

CodeGlean: a static, client-side-only web app that recovers code files from exported Claude web-chat `Conversation.json` files. It replays `+`/`-` diffs embedded in assistant messages chronologically to reconstruct full files as they existed at each point in the conversation, and lets the user download individual files or the newest state of everything as a `.zip`.

No backend, no build step, no npm dependencies. Everything runs in the browser; nothing is uploaded anywhere.

## Commands

There is no build/lint/test tooling (no `package.json`). To run the app locally:

```bash
npx serve .          # or: python3 -m http.server
```

Then open the served URL. `resolve.js` also exports its API via `module.exports` when run under Node (`require('./resolve.js')`), which is useful for exercising the resolver logic directly in a Node REPL without a browser — but there is no existing test harness/script for this.

Note: opening `index.html` directly via `file://` will NOT auto-load conversation JSON, since browsers block `fetch()` on `file://`. Use a local server, or drag-and-drop / "Choose JSON" instead.

## Architecture

Three plain scripts, loaded in order in `index.html`: `resolve.js` → `app.js` (plus vendored libs in `vendor/`: `marked`, `DOMPurify`, `highlight.js`, `JSZip`).

### `resolve.js` — diff replay engine (`window.ConversationResolve`)

This is the core/hard part of the app. It reconstructs full files from a custom, non-git diff format found in these conversation exports: no headers, no `@@` hunks, just lines prefixed with `' '` (context), `'+'` (added), `'-'` (removed), inside fences tagged like `**path/to/file** (new)` or `**path/to/file** (diff)`.

Flow, in order:
1. **`tokenize(raw)`** — scans one assistant message's markdown for path-headed code fences and classifies each as `full` (whole file) or `diff` (hunk to apply). Handles edge cases: headerless diff fences that continue a preceding diff for the same file, headers separated from their fence by prose (paired via a second pass), and "lives at `path`" prose hints for orphaned full-file fences (third pass).
2. **`resolveAll(msgs)`** — walks all messages oldest→newest, maintaining a `states` map of `path -> {lines, lang, revs}`. For each `full` event it seeds/replaces file state directly. For each `diff` event it calls `applyDiff`.
3. **`applyDiff(current, bodies)`** tries three strategies in order, falling back on failure:
   - `applyOne` (strict): walk the diff top-to-bottom, matching context/removed lines exactly via `findLine`.
   - `applyOne` (loose): same, but whitespace-tolerant matching.
   - `applyRuns`: splits the diff into independent change "runs" (each anchored by surrounding context) and locates/applies each run independently via `locateSeq`/`applyRunAt`. This handles hunks whose clusters don't appear in file order, or drifted diffs, at the cost of requiring unambiguous anchors.
4. Diffs that still fail to apply are recorded in `failures` (shown in the app's "Unapplied diffs" view) instead of silently dropped.
5. Files are matched across messages primarily by path, with a `byBase`/`canonicalFor` fallback that resolves diffs referencing only a basename to the single matching known file (fails safe — ambiguous basenames are left unresolved).

When editing diff-matching logic, the strict→loose→runs fallback order and the "fail rather than guess wrong" posture (leaving unresolved diffs visible with a reason) are intentional — don't make failure silent.

### `app.js` — UI layer

Single IIFE, plain DOM manipulation (no framework). Key responsibilities:
- `parseData` — validates/sorts `chat_messages`, calls `ConversationResolve.resolveAll`, and drives all downstream rendering/state (`state` object at the top of the file).
- `render()` — renders the timeline of messages (respecting sender filter + search query), decorates code blocks (`decorateCodeBlocks`) with collapse/expand, language, line count, and a status badge (`original` / `reconstructed` / `unresolved`).
- `attachDiffToggles` — lets a user flip a reconstructed code block between the rebuilt full file and the original raw diff, matched positionally against `originalDiffs` produced by `resolve.js`.
- `renderDiffs()` — the "Unapplied diffs" view, listing `state.failures` with reasons.
- `downloadAllFiles` — zips `state.fileStates` (newest state per file) via JSZip, with a staggered per-file-download fallback if JSZip is unavailable.
- On load, `tryFetch` auto-loads `./Conversation.json`, then `./conversation.json`, then `./sample-conversation.json` — in that order — so a fresh clone shows a working demo with zero setup.

Rendered markdown goes through `marked` then `DOMPurify.sanitize` before `innerHTML` — never bypass this when adding new render paths, since conversation exports are untrusted input.

### Data flow

`Conversation.json` → `parseData` (app.js) → sort by `created_at` → `ConversationResolve.resolveAll` (resolve.js) → per-message `display` HTML + per-file `states` → `render()` builds the timeline DOM; `downloadAllFiles` zips `states`.
