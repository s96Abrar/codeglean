/* Diff resolver: reconstruct full files from the simplified +/- diffs used in
 * this conversation export. Diffs are NOT git diffs: no headers, no @@ hunks,
 * just lines prefixed with ' ' (context), '+' (added), '-' (removed).
 *
 * Strategy: walk messages oldest -> newest, track per-file line state seeded by
 * full-file blocks. Each diff is split into independent edit clusters, every
 * cluster's position is independently verified against the current file (never
 * guessed), then serialized into a real unified-diff patch and applied via the
 * vendored jsdiff engine (vendor/diff.min.js) — see buildHunk/buildPatchText.
 *
 * Browser: <script src="resolve.js"> exposes window.ConversationResolve.
 * Node: require('./resolve.js').
 */
(function (root) {
  "use strict";

  var diffEngine = null;
  function patchEngine() {
    if (diffEngine) return diffEngine;
    diffEngine = (typeof window !== "undefined" && window.Diff) ? window.Diff
      : (typeof require === "function" ? require("./vendor/diff.min.js") : null);
    if (!diffEngine) throw new Error("jsdiff (vendor/diff.min.js) is not loaded");
    return diffEngine;
  }

  // Optional **path** header (with optional (note) and/or — note) immediately
  // followed by a fenced code block. Bare fences match too (header undefined).
  var BLOCK_RE = /(?:\*\*([^\n]+?)\*\*(?:\s*\(([^)]*)\))?(?:\s*[—–-]\s*([^\n]*))?\s*\n)?```(\w*)\n([\s\S]*?)\n```/g;
  var HEADER_RE = /\*\*([^\n]+?)\*\*(?:\s*\(([^)]*)\))?(?:\s*[—–-]\s*([^\n]*))?/g;
  var LIVES_AT_RE = /lives at `([^`]+)`/;

  function normPath(p) {
    var s = String(p).trim().replace(/^`+|`+$/g, "");
    var poss = s.indexOf("'s ");
    if (poss !== -1) s = s.slice(poss + "'s ".length);
    return s.replace(/\/+/g, "/").replace(/^\.\//, "");
  }

  function looksLikePath(p) {
    var s = String(p).trim();
    if (s === "ix" || s.charAt(0) === ".") return true;
    if (s.indexOf("/") !== -1) return true;
    return /[\w+]+\.\w+$/.test(s);
  }

  function classify(paren, note, fenceLang) {
    var hint = ((paren || "") + " " + (note || "")).toLowerCase();
    // NB: "full file, not a diff" contains both words — full-file wins.
    if (/full file/.test(hint)) return "full";
    if (/diff/.test(hint)) return "diff";
    if (/new/.test(hint)) return "full";
    if ((fenceLang || "").toLowerCase() === "diff") return "diff";
    return "full";
  }

  function inferLang(path, fenceLang) {
    if (fenceLang && fenceLang.toLowerCase() !== "diff") return fenceLang;
    var m = /\.([a-z0-9]+)$/i.exec(path || "");
    var ext = m ? m[1].toLowerCase() : "";
    if (ext === "swift") return "swift";
    if (ext === "plist" || ext === "xml") return "xml";
    if (ext === "rb") return "ruby";
    if (ext === "sh") return "bash";
    if (ext === "json") return "json";
    if (ext === "md") return "markdown";
    if (!ext && /^(ix|build|make-|package|notarize)/.test(path || "")) return "bash";
    if (path === "ix") return "bash";
    return "";
  }

  function isEllipsis(core) {
    var t = core.trim();
    return t === "..." || t === "…";
  }

  function trimBoth(s) {
    return String(s).replace(/^\s+|\s+$/g, "");
  }

  // Lenient anchor comparison: ignores surrounding whitespace and treats
  // "(...)" as an LLM abbreviation of a longer line.
  function anchorEq(fileLine, target) {
    var ab = target.indexOf("(...)");
    if (ab !== -1) {
      var pre = trimBoth(target.slice(0, ab));
      return trimBoth(fileLine).slice(0, pre.length) === pre;
    }
    return trimBoth(fileLine) === trimBoth(target);
  }

  // Split a flat diff into independent edit clusters. Each cluster = leading
  // context + interleaved -/+ ops + trailing context. A cluster boundary is
  // forced (a) whenever context follows at least one op and more ops appear
  // after (a fresh edit site restated with its own context), and (b) at an
  // "..." omission marker, which explicitly disclaims contiguity. Clusters
  // are anchored and expanded independently (see buildHunk), so edits that
  // appear out of file order, or with large stretches of unlisted unchanged
  // lines between them, still resolve correctly.
  function splitClusters(diffLines) {
    var clusters = [];
    var pending = [];
    var cur = null;
    var anchored = false;
    for (var n = 0; n < diffLines.length; n++) {
      var d = diffLines[n];
      var op = d.charAt(0);
      var core = (op === "+" || op === "-" || op === " ") ? d.slice(1) : d;
      if (isEllipsis(core)) {
        if (cur) { clusters.push(cur); cur = null; }
        pending = [];
        continue;
      }
      if (d === "") { op = " "; core = ""; }
      if (op === "+" || op === "-") {
        if (cur && cur.trailing.length) {
          clusters.push(cur);
          cur = { leading: cur.trailing.slice(-30), ops: [], trailing: [] };
        } else if (!cur) {
          cur = { leading: pending.slice(-30), ops: [], trailing: [] };
          pending = [];
        }
        cur.ops.push({ op: op, line: d.slice(1) });
        if (op === "-") anchored = true;
      } else if (op === " ") {
        if (cur) cur.trailing.push(core);
        else pending.push(core);
        anchored = true;
      } else {
        return null; // unexpected prefix: not a parseable hunk
      }
    }
    if (cur) clusters.push(cur);
    if (!anchored) return null; // pure-add hunk: position unknowable
    return clusters;
  }

  // Forward search tolerant of unlisted gaps: the pseudo-diff format has no
  // line numbers, so most real diffs only restate a line or two of context
  // near each edit and leave everything else out (observed empirically:
  // ~94% of diffs in a real conversation skip at least one unlisted line,
  // sometimes 100+). buildHunk backfills whatever this finds as ordinary
  // unchanged context so the emitted hunk stays a valid, contiguous slice.
  function findForward(lines, from, target) {
    for (var i = from; i < lines.length; i++) {
      if (anchorEq(lines[i], target)) return i;
    }
    return -1;
  }

  // Walk one cluster's items forward from a specific candidate start
  // position — applyOne's proven cursor-walk algorithm, parameterized on
  // where it starts instead of always starting at 0, and backfilling
  // unlisted gaps as ordinary context (see findForward) along the way.
  //
  // trailingFrom: index in `items` where pure trailing context begins (after
  // all ops). Nothing is being edited there — it exists only to help confirm
  // position — so if it can't be found going forward (e.g. it's actually
  // restating earlier-in-file content, as diffs in this format sometimes do
  // right after a pure-add edit), the walk is simply truncated there instead
  // of failing outright. Leading context and ops are never truncated: they
  // represent the edit itself and must genuinely resolve.
  //
  // Returns {ok, oldStart, oldEnd, trailingStart, dels: {oldIndex: true},
  // adds: {oldIndex: [lines inserted immediately before oldIndex]}, added,
  // removed} — an interval [oldStart, oldEnd) of `current` plus sparse edits
  // within it, rather than a flat line-by-line body. This shape is what
  // makes merging two overlapping/nested hunks (see buildPatchText) a plain
  // interval and map union instead of fragile array splicing. trailingStart
  // is the position where trailing context begins (== oldEnd if there is
  // none): the next cluster's leading is always this same trailing content,
  // so buildPatchText uses it to try that cluster's anchor directly there
  // first, before falling back to a full-file search.
  function walkClusterFrom(current, items, anchorIdx, startAt, trailingFrom) {
    var dels = {}, adds = {};
    var added = 0, removed = 0;
    var cursor = startAt;
    var leadingAdds = [];
    var trailingStart = null;
    function addAt(pos, line) { (adds[pos] || (adds[pos] = [])).push(line); added++; }

    for (var n = 0; n < items.length; n++) {
      if (n === trailingFrom) trailingStart = cursor;
      var it = items[n];
      if (it.op === "+") {
        if (n < anchorIdx) leadingAdds.push(it.line);
        else addAt(cursor, it.line);
        continue;
      }
      var k = (n === anchorIdx) ? startAt : findForward(current, cursor, it.line);
      if (k === -1) {
        if (n >= trailingFrom) break; // drop unverifiable trailing, keep what's confirmed
        return { ok: false };
      }
      if (n === anchorIdx) { for (var la = 0; la < leadingAdds.length; la++) addAt(startAt, leadingAdds[la]); }
      if (it.op === "-") { dels[k] = true; removed++; }
      cursor = k + 1;
    }
    if (trailingStart === null) trailingStart = cursor;
    return { ok: true, oldStart: startAt, oldEnd: cursor, trailingStart: trailingStart, dels: dels, adds: adds, added: added, removed: removed };
  }

  // cursorHint: where the previous cluster in this same diff left off. Most
  // clusters are the next sequential edit in the same narrative, so their
  // anchor — even a generic one like a lone "}" — is simply the next line
  // after the previous edit; trying that position first (and using it
  // whenever it actually matches) reproduces applyOne's single-cursor
  // behavior for the common case. Only when continuation doesn't hold (a
  // genuinely out-of-order/scattered cluster) does this fall back to
  // searching the whole file and disambiguating among candidates.
  function buildHunk(current, cluster, cursorHint) {
    // Reconstruct this cluster's own flat item sequence (leading context,
    // interleaved ops, trailing context) in original diff order.
    var items = [];
    cluster.leading.forEach(function (l) { items.push({ op: " ", line: l }); });
    cluster.ops.forEach(function (o) { items.push(o); });
    cluster.trailing.forEach(function (l) { items.push({ op: " ", line: l }); });

    var anchorIdx = -1;
    for (var a = 0; a < items.length; a++) {
      if (items[a].op !== "+") { anchorIdx = a; break; }
    }
    if (anchorIdx === -1) return { ok: false, reason: "add-only hunk has no anchor" };
    var trailingFrom = cluster.leading.length + cluster.ops.length;

    if (cursorHint != null && anchorEq(current[cursorHint], items[anchorIdx].line)) {
      var direct = walkClusterFrom(current, items, anchorIdx, cursorHint, trailingFrom);
      if (direct.ok) return direct;
    }

    // The anchor LINE alone (e.g. a lone "}" or a blank line) is often not
    // globally unique. Try every occurrence as a candidate start and walk
    // the whole cluster forward from each (with gap backfill). Because
    // findForward searches with no upper bound, a candidate that starts too
    // early will often still "succeed" — it just backfills a lot of
    // unrelated content on its way to the same unique content a correctly-
    // placed candidate would reach directly. So a bare "did it succeed" test
    // doesn't disambiguate; the candidate that needed to backfill the LEAST
    // (smallest span) is the one actually anchored at the edit, and is
    // required to be the unique minimum — a tie means the cluster's content
    // is genuinely ambiguous and must fail loud rather than guess.
    var successes = [];
    for (var i = 0; i < current.length; i++) {
      if (!anchorEq(current[i], items[anchorIdx].line)) continue;
      var r = walkClusterFrom(current, items, anchorIdx, i, trailingFrom);
      if (r.ok) successes.push(r);
    }
    if (successes.length === 0) return { ok: false, reason: "anchor not found" };
    var minSpan = Math.min.apply(null, successes.map(function (s) { return s.oldEnd - s.oldStart; }));
    var best = successes.filter(function (s) { return (s.oldEnd - s.oldStart) === minSpan; });
    if (best.length > 1) return { ok: false, reason: "anchor ambiguous" };
    return best[0];
  }

  // Build a real unified-diff patch text from a flat pseudo-diff, with every
  // hunk's position independently verified against `current` (never guessed,
  // never left to the patch engine's own search — see buildHunk).
  function buildPatchText(current, diffLines) {
    var clusters = splitClusters(diffLines);
    if (!clusters || !clusters.length) {
      return { ok: false, reason: "hunk has no anchor lines or bad prefix" };
    }
    var hunks = [];
    var cursorHint = null;
    for (var c = 0; c < clusters.length; c++) {
      var h = buildHunk(current, clusters[c], cursorHint);
      if (!h.ok) return { ok: false, reason: "cluster " + c + " of " + clusters.length + ": " + h.reason };
      hunks.push(h);
      cursorHint = h.trailingStart;
    }
    // Overlapping ranges are expected, not just at cluster boundaries: a
    // cluster's trailing context can run for a while (see the trailing-
    // truncation note above) and legitimately swallow another cluster's
    // whole span, including when that other cluster's real file position
    // comes earlier than this one's despite appearing first in the diff.
    // None of that is a conflict as long as every position in the overlap
    // agrees on whether it's touched — merge by unioning the [oldStart,
    // oldEnd) intervals and their sparse dels/adds maps; a real conflict
    // (two clusters editing the very same line differently) still fails
    // loudly rather than guessing.
    hunks.sort(function (a, b) { return a.oldStart - b.oldStart; });
    var merged = [];
    for (var i = 0; i < hunks.length; i++) {
      var h = hunks[i];
      var last = merged[merged.length - 1];
      if (last && h.oldStart <= last.oldEnd) {
        for (var pos in h.dels) { last.dels[pos] = true; }
        for (var apos in h.adds) {
          last.adds[apos] = (last.adds[apos] || []).concat(h.adds[apos]);
        }
        last.oldEnd = Math.max(last.oldEnd, h.oldEnd);
        last.added += h.added;
        last.removed += h.removed;
      } else {
        merged.push({ oldStart: h.oldStart, oldEnd: h.oldEnd, dels: Object.assign({}, h.dels), adds: Object.assign({}, h.adds), added: h.added, removed: h.removed });
      }
    }
    hunks = merged;
    var text = "--- a\n+++ b\n";
    var delta = 0, added = 0, removed = 0;
    hunks.forEach(function (h) {
      var newStart = h.oldStart + delta;
      var lines = [];
      var oldCount = 0, newCount = 0;
      for (var p = h.oldStart; p <= h.oldEnd; p++) {
        (h.adds[p] || []).forEach(function (l) { lines.push("+" + l); newCount++; });
        if (p === h.oldEnd) break;
        if (h.dels[p]) { lines.push("-" + current[p]); oldCount++; }
        else { lines.push(" " + current[p]); oldCount++; newCount++; }
      }
      text += "@@ -" + (h.oldStart + 1) + "," + oldCount + " +" + (newStart + 1) + "," + newCount + " @@\n";
      text += lines.join("\n") + "\n";
      delta += newCount - oldCount;
      added += h.added;
      removed += h.removed;
    });
    return { ok: true, text: text, added: added, removed: removed };
  }

  function applyDiff(current, bodies) {
    var diffLines = bodies.join("\n").split("\n");
    while (diffLines.length && diffLines[0] === "") diffLines.shift();
    while (diffLines.length && diffLines[diffLines.length - 1] === "") diffLines.pop();
    var patch = buildPatchText(current, diffLines);
    if (!patch.ok) return patch;
    var result;
    try {
      result = patchEngine().applyPatch(current.join("\n"), patch.text, { fuzzFactor: 0 });
    } catch (e) {
      return { ok: false, reason: "patch engine rejected a pre-verified hunk: " + e.message };
    }
    if (result === false) return { ok: false, reason: "patch engine rejected a pre-verified hunk" };
    return { ok: true, lines: result.split("\n"), added: patch.added, removed: patch.removed, method: "patch" };
  }

  function basename(p) {
    var i = p.lastIndexOf("/");
    return i === -1 ? p : p.slice(i + 1);
  }

  function inRanges(ranges, pos) {
    for (var i = 0; i < ranges.length; i++) {
      if (pos >= ranges[i][0] && pos < ranges[i][1]) return true;
    }
    return false;
  }

  // Tokenize one message's markdown into file events.
  // Headerless ```diff fences merge into the pending same-message diff;
  // headerless diffs with no pending diff become unattributed (try-all-files).
  // Headers separated from their fence by prose are paired in a second pass.
  function tokenize(raw) {
    var events = [];
    var skipped = []; // headerless (or non-path-header) fences: {start,end,lang,body}
    var pendingDiff = null;
    var match;
    BLOCK_RE.lastIndex = 0;
    while ((match = BLOCK_RE.exec(raw)) !== null) {
      var header = match[1];
      var paren = match[2];
      var note = match[3];
      var fenceLang = match[4] || "";
      var body = match[5];
      var start = match.index;
      var end = BLOCK_RE.lastIndex;
      var isPath = header !== undefined && looksLikePath(header);

      if (!isPath) {
        if (fenceLang.toLowerCase() === "diff" && pendingDiff) {
          pendingDiff.bodies.push(body);
          pendingDiff.ranges.push([start, end]);
        } else if (fenceLang.toLowerCase() === "diff") {
          var un = {
            displayPath: null, path: null, kind: "diff", fenceLang: fenceLang,
            bodies: [body], ranges: [[start, end]], headers: [], unattributed: true
          };
          events.push(un);
          pendingDiff = un;
        } else {
          skipped.push({ start: start, end: end, lang: fenceLang, body: body });
        }
        continue;
      }

      var path = normPath(header);
      var kind = classify(paren, note, fenceLang);
      if (kind === "diff" && pendingDiff && !pendingDiff.unattributed && pendingDiff.path === path) {
        pendingDiff.bodies.push(body);
        pendingDiff.ranges.push([start, end]);
        pendingDiff.headers.push(header.trim());
        continue;
      }
      pendingDiff = null;
      var ev = {
        displayPath: header.trim(), path: path, kind: kind, fenceLang: fenceLang,
        bodies: [body], ranges: [[start, end]], headers: [header.trim()],
        rewrite: kind === "diff"
      };
      events.push(ev);
      if (kind === "diff") pendingDiff = ev;
    }

    // Second pass: pair path-like headers that never got an adjacent fence
    // (prose sits between header and fence) with the nearest following
    // unconsumed fence before the next header.
    var consumed = [];
    events.forEach(function (e) {
      e.ranges.forEach(function (r) { consumed.push(r); });
    });
    var headers = [];
    HEADER_RE.lastIndex = 0;
    var hm;
    while ((hm = HEADER_RE.exec(raw)) !== null) {
      if (looksLikePath(hm[1]) && !inRanges(consumed, hm.index)) {
        headers.push({
          start: hm.index, end: hm.index + hm[0].length,
          displayPath: hm[1].trim(), path: normPath(hm[1]),
          kind: classify(hm[2], hm[3], "")
        });
      }
    }
    var usedSkip = {};
    headers.forEach(function (h) {
      var limit = Infinity;
      var i;
      for (i = 0; i < headers.length; i++) {
        if (headers[i].start > h.start && headers[i].start < limit) limit = headers[i].start;
      }
      for (i = 0; i < consumed.length; i++) {
        if (consumed[i][0] > h.start && consumed[i][0] < limit) limit = consumed[i][0];
      }
      for (i = 0; i < skipped.length; i++) {
        var s = skipped[i];
        if (usedSkip[i] || s.start < h.end || s.end > limit) continue;
        if (s.start - h.end > 2000) continue;
        var wantDiff = h.kind === "diff";
        var isDiff = (s.lang || "").toLowerCase() === "diff";
        if (wantDiff !== isDiff) continue;
        usedSkip[i] = true;
        events.push({
          displayPath: h.displayPath, path: h.path, kind: h.kind, fenceLang: s.lang,
          bodies: [s.body], ranges: [[s.start, s.end]], headers: [h.displayPath],
          rewrite: h.kind === "diff", paired: true
        });
        return;
      }
    });

    // Third pass: "lives at `path`" seeds for still-unpaired full fences.
    skipped.forEach(function (s, i) {
      if (usedSkip[i] || (s.lang || "").toLowerCase() === "diff") return;
      var ctx = raw.slice(Math.max(0, s.start - 800), Math.min(raw.length, s.end + 800));
      var lm = LIVES_AT_RE.exec(ctx);
      if (lm && looksLikePath(lm[1])) {
        usedSkip[i] = true;
        events.push({
          displayPath: lm[1].trim(), path: normPath(lm[1]), kind: "full", fenceLang: s.lang,
          bodies: [s.body], ranges: [], headers: [], rewrite: false, seeded: true
        });
      }
    });

    // Keep chronological order for application.
    events.sort(function (a, b) {
      var ra = a.ranges.length ? a.ranges[0][0] : Infinity;
      var rb = b.ranges.length ? b.ranges[0][0] : Infinity;
      return ra - rb;
    });
    return events;
  }

  // Resolve display markdown for a sorted [{uuid, sender, created, raw}] list.
  function resolveAll(msgs) {
    var states = {}; // canonical path -> {lines, lang, revs, updatedAt, display}
    var byBase = {}; // basename -> [canonical paths]
    var stats = {
      totalEvents: 0, fullEvents: 0, diffEvents: 0,
      diffApplied: 0, diffFailed: 0, inferredApplied: 0, pairedEvents: 0
    };
    var failures = [];

    function register(path) {
      var b = basename(path);
      if (!byBase[b]) byBase[b] = [];
      if (byBase[b].indexOf(path) === -1) byBase[b].push(path);
    }

    function canonicalFor(path) {
      if (states[path]) return path;
      var cands = (byBase[basename(path)] || []).filter(function (c) { return !!states[c]; });
      if (cands.length === 1) return cands[0];
      return null;
    }

    var out = msgs.map(function (m) {
      if (m.sender !== "assistant") return { uuid: m.uuid, display: m.raw, files: [], originalDiffs: [] };
      var events = tokenize(m.raw);
      if (!events.length) return { uuid: m.uuid, display: m.raw, files: [], originalDiffs: [] };

      var repl = [];
      // Files written/updated by THIS message (latest snapshot wins on repeats).
      var msgFiles = [];
      var msgFileIdx = {};
      // Raw diffs behind each applied hunk, in order (for per-file toggle).
      var msgDiffs = [];
      function snapFile(canonPath, displayPath, info) {
        var entry = {
          path: canonPath,
          name: basename(canonPath),
          display: displayPath || canonPath,
          lang: states[canonPath].lang || "",
          lines: states[canonPath].lines.length,
          text: states[canonPath].lines.join("\n"),
          rev: states[canonPath].revs,
          kind: info.kind, added: info.added || 0, removed: info.removed || 0
        };
        if (msgFileIdx[canonPath] !== undefined) msgFiles[msgFileIdx[canonPath]] = entry;
        else { msgFileIdx[canonPath] = msgFiles.length; msgFiles.push(entry); }
      }
      events.forEach(function (ev) {
        stats.totalEvents++;
        if (ev.paired || ev.seeded) stats.pairedEvents++;
        if (ev.kind === "full") {
          stats.fullEvents++;
          states[ev.path] = {
            lines: ev.bodies[0].split("\n"),
            lang: inferLang(ev.path, ev.fenceLang),
            revs: (states[ev.path] ? states[ev.path].revs : 0) + 1,
            updatedAt: m.created,
            display: ev.displayPath
          };
          register(ev.path);
          snapFile(ev.path, ev.displayPath, { kind: states[ev.path].revs <= 1 ? "new" : "full" });
          return; // full blocks already display as-is
        }
        stats.diffEvents++;
        var canon = ev.path ? canonicalFor(ev.path) : null;
        var res = null;
        if (ev.path && canon) {
          res = applyDiff(states[canon].lines, ev.bodies);
        } else if (!ev.path) {
          // Unattributed diff: apply to whichever single known file fits.
          var fits = [];
          var keys = Object.keys(states);
          for (var i = 0; i < keys.length; i++) {
            var r = applyDiff(states[keys[i]].lines, ev.bodies);
            if (r.ok) fits.push({ key: keys[i], res: r });
          }
          if (fits.length === 1) {
            canon = fits[0].key;
            res = fits[0].res;
            stats.inferredApplied++;
          }
        }
        if (!canon || !res || !res.ok) {
          stats.diffFailed++;
          var why = !canon
            ? (ev.path ? "no known base file yet" : "no single known file fits this hunk")
            : res.reason;
          failures.push({ created: m.created, uuid: m.uuid, path: ev.displayPath || "(unattributed diff)", reason: why, diff: ev.bodies.join("\n") });
          if (ev.ranges.length) {
            repl.push({
              start: ev.ranges[0][0], end: ev.ranges[0][0],
              text: "> **Diff not applied**" +
                (ev.displayPath ? " for `" + ev.displayPath + "`" : "") +
                " (" + why + ") — showing the original diff below.\n\n"
            });
          }
          return;
        }
        stats.diffApplied++;
        var st = states[canon];
        st.lines = res.lines;
        st.revs++;
        st.updatedAt = m.created;
        if (!st.lang) st.lang = inferLang(canon, "");
        var label = ev.displayPath || canon;
        snapFile(canon, label, { kind: "updated", added: res.added, removed: res.removed });
        msgDiffs.push(ev.bodies.join("\n"));
        var tag = ev.path ? "" : " (file inferred)";
        var header = "**" + label + "** — full file (reconstructed from diff" + tag +
          " · rev " + st.revs + " · +" + res.added + "/-" + res.removed + ")";
        var full = header + "\n\n```" + (st.lang || "") + "\n" + res.lines.join("\n") + "\n```";
        repl.push({ start: ev.ranges[0][0], end: ev.ranges[0][1], text: full });
        for (var q = 1; q < ev.ranges.length; q++) {
          repl.push({ start: ev.ranges[q][0], end: ev.ranges[q][1], text: "" });
        }
      });

      if (!repl.length) return { uuid: m.uuid, display: m.raw, files: msgFiles, originalDiffs: msgDiffs };
      repl.sort(function (a, b) { return a.start - b.start; });
      var s = "";
      var pos = 0;
      repl.forEach(function (rp) {
        s += m.raw.slice(pos, rp.start) + rp.text;
        pos = rp.end;
      });
      s += m.raw.slice(pos);
      return { uuid: m.uuid, display: s, files: msgFiles, originalDiffs: msgDiffs };
    });

    return { messages: out, states: states, stats: stats, failures: failures };
  }

  var api = {
    tokenize: tokenize,
    applyDiff: applyDiff,
    normPath: normPath,
    inferLang: inferLang,
    resolveAll: resolveAll
  };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    root.ConversationResolve = api;
  }
})(typeof window !== "undefined" ? window : this);
