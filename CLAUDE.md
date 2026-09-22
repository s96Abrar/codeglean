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

Four plain scripts, loaded in order in `index.html`: `diff.min.js` (jsdiff, vendored) → `resolve.js` → `app.js` (plus other vendored libs in `vendor/`: `marked`, `DOMPurify`, `highlight.js`, `JSZip`).

### `resolve.js` — diff replay engine (`window.ConversationResolve`)

This is the core/hard part of the app. It reconstructs full files from a custom, non-git diff format found in these conversation exports: no headers, no `@@` hunks, just lines prefixed with `' '` (context), `'+'` (added), `'-'` (removed), inside fences tagged like `**path/to/file** (new)` or `**path/to/file** (diff)`. It has no line numbers and frequently omits large stretches of unlisted unchanged lines between edits with no marker at all — real diffs in this format restate only a line or two of context near each edit, not full surrounding context.

Flow, in order:
1. **`tokenize(raw)`** — scans one assistant message's markdown for path-headed code fences and classifies each as `full` (whole file) or `diff` (hunk to apply). Handles edge cases: headerless diff fences that continue a preceding diff for the same file, headers separated from their fence by prose (paired via a second pass), and "lives at `path`" prose hints for orphaned full-file fences (third pass).
2. **`resolveAll(msgs)`** — walks all messages oldest→newest, maintaining a `states` map of `path -> {lines, lang, revs}`. For each `full` event it seeds/replaces file state directly. For each `diff` event it calls `applyDiff`.
3. **`applyDiff(current, bodies)`** converts the pseudo-diff into a real unified-diff patch and applies it via the vendored jsdiff engine (`vendor/diff.min.js`), rather than hand-rolling the splice:
   - **`splitClusters(diffLines)`** breaks the flat diff into independent edit clusters (leading context + ops + trailing context), forcing a boundary wherever context follows an op and more ops appear after (a fresh edit site), or at an `"..."`/`"…"` omission marker.
   - **`buildHunk(current, cluster, cursorHint)`** anchors one cluster against `current` and expands it into a self-contained hunk. A cluster's anchor line alone (often just `"}"` or a blank line) is rarely globally unique, and because the forward search has no upper bound, a wrong starting candidate will often still "succeed" by backfilling a lot of unrelated content on its way to the same later match a correct candidate would reach directly — so `buildHunk` tries every occurrence, walks the whole cluster forward from each (see `walkClusterFrom`/`findForward`), and requires the candidate with the smallest resulting span to be the unique minimum. `cursorHint` (the previous cluster's `trailingStart`) is tried first, since most clusters are the next sequential edit in the same narrative — this reproduces single-cursor continuation for the common case and only falls back to the full-file search for genuinely out-of-order clusters.
   - **`buildPatchText(current, diffLines)`** builds all of a diff's hunks this way, then merges any that overlap (adjacent clusters share their boundary context by construction, and a cluster's trailing can legitimately run for a while and swallow another cluster's whole span) by unioning their `[oldStart, oldEnd)` intervals and sparse edit maps, and serializes the result into a real `@@ -oldStart,oldCount +newStart,newCount @@` patch.
   - The assembled patch is handed to `Diff.applyPatch` (jsdiff). jsdiff itself is used purely as the line-splice engine on hunks whose anchors were already independently verified — it is never trusted to search for or disambiguate a hunk's position itself (it doesn't detect ambiguous context; it will silently pick a plausible-but-wrong location if asked to).
4. Diffs that still fail to apply (0 or >1 anchor candidates, or a genuinely pure-add hunk with no anchor at all) are recorded in `failures` (shown in the app's "Unapplied diffs" view) instead of silently dropped or guessed.
5. Files are matched across messages primarily by path, with a `byBase`/`canonicalFor` fallback that resolves diffs referencing only a basename to the single matching known file (fails safe — ambiguous basenames are left unresolved).

When editing diff-matching logic, the "fail rather than guess wrong" posture (leaving unresolved diffs visible with a reason instead of silently mis-applying) is intentional and load-bearing — a prior version of this resolver had bugs that looked like successes but silently corrupted reconstructed files (e.g. new code landing above a file's `import` line). Any change here should be checked against a real exported conversation, not just unit-style snippets: verify `stats.diffApplied` doesn't regress, and spot-check reconstructed files for structural sanity (e.g. brace balance for curly-brace languages).

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
