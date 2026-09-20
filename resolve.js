/* Diff resolver: reconstruct full files from the simplified +/- diffs used in
 * this conversation export. Diffs are NOT git diffs: no headers, no @@ hunks,
 * just lines prefixed with ' ' (context), '+' (added), '-' (removed).
 *
 * Strategy: walk messages oldest -> newest, track per-file line state seeded by
 * full-file blocks, and apply each diff with a forward-searching cursor so both
 * full-file diffs and partial hunks resolve to the complete new file.
 *
 * Browser: <script src="resolve.js"> exposes window.ConversationResolve.
 * Node: require('./resolve.js').
 */
(function (root) {
  "use strict";

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

  function findLine(lines, from, target, loose) {
    var i, cand, t;
    var abbr = target.indexOf("(...)");
    if (abbr !== -1) {
      // Abbreviated context ("LanguageGrammar(...)"): prefix match.
      var prefix = loose ? target.slice(0, abbr).replace(/\s+$/g, "") : target.slice(0, abbr);
      for (i = from; i < lines.length; i++) {
        cand = loose ? lines[i].replace(/\s+$/g, "") : lines[i];
        if (cand.slice(0, prefix.length) === prefix) return i;
      }
      return -1;
    }
    if (!loose) {
      for (i = from; i < lines.length; i++) {
        if (lines[i] === target) return i;
      }
      return -1;
    }
    t = target.replace(/\s+$/g, "");
    for (i = from; i < lines.length; i++) {
      if (lines[i].replace(/\s+$/g, "") === t) return i;
    }
    return -1;
  }

  // Apply one diff body to current lines. Returns {ok, lines, added, removed}.
  function applyOne(current, diffLines, loose) {
    var out = [];
    var i = 0;
    var added = 0;
    var removed = 0;
    var matched = 0;
    var k, j;
    for (var n = 0; n < diffLines.length; n++) {
      var d = diffLines[n];
      var op = d.charAt(0);
      var core = (op === "+" || op === "-" || op === " ") ? d.slice(1) : d;
      if (isEllipsis(core)) continue; // "..." omission marker: matches anything
      if (op === "+") {
        out.push(d.slice(1));
        added++;
      } else if (op === "-") {
        k = findLine(current, i, d.slice(1), loose);
        if (k === -1) return { ok: false, reason: "removed line not found: " + JSON.stringify(d.slice(1).slice(0, 80)) };
        for (j = i; j < k; j++) out.push(current[j]);
        i = k + 1;
        removed++;
      } else if (op === " ") {
        k = findLine(current, i, d.slice(1), loose);
        if (k === -1) return { ok: false, reason: "context line not found: " + JSON.stringify(d.slice(1).slice(0, 80)) };
        for (j = i; j < k; j++) out.push(current[j]);
        out.push(current[k]);
        i = k + 1;
        matched++;
      } else if (d === "") {
        k = findLine(current, i, "", loose);
        if (k === -1) return { ok: false, reason: "blank context line not found" };
        for (j = i; j < k; j++) out.push(current[j]);
        out.push(current[k]);
        i = k + 1;
        matched++;
      } else {
        return { ok: false, reason: "unexpected diff line prefix: " + JSON.stringify(d.slice(0, 40)) };
      }
    }
    for (j = i; j < current.length; j++) out.push(current[j]);
    return { ok: true, lines: out, added: added, removed: removed, matched: matched };
  }

  function trimBoth(s) {
    return String(s).replace(/^\s+|\s+$/g, "");
  }

  // Lenient anchor comparison for the run-based fallback: ignores surrounding
  // whitespace and treats "(...)" as an LLM abbreviation of a longer line.
  function anchorEq(fileLine, target) {
    var ab = target.indexOf("(...)");
    if (ab !== -1) {
      var pre = trimBoth(target.slice(0, ab));
      return trimBoth(fileLine).slice(0, pre.length) === pre;
    }
    return trimBoth(fileLine) === trimBoth(target);
  }

  function contigAt(lines, from, seq) {
    if (from < 0 || from + seq.length > lines.length) return false;
    for (var k = 0; k < seq.length; k++) {
      if (!anchorEq(lines[from + k], seq[k])) return false;
    }
    return true;
  }

  function locateSeq(lines, seq) {
    var hits = [];
    if (!seq.length) return hits;
    for (var i = 0; i + seq.length <= lines.length; i++) {
      if (contigAt(lines, i, seq)) hits.push(i);
    }
    return hits;
  }

  // Split a diff into independent change runs. Each run = leading context +
  // interleaved -/+ ops + trailing context. Context is shared across the gap
  // between adjacent runs (both sides verify against the same region; only
  // leading+dels are consumed by a splice, so sharing is safe).
  function parseRuns(diffLines) {
    var runs = [];
    var pending = [];
    var cur = null;
    var anchored = false;
    for (var n = 0; n < diffLines.length; n++) {
      var d = diffLines[n];
      var op = d.charAt(0);
      var core = (op === "+" || op === "-" || op === " ") ? d.slice(1) : d;
      if (isEllipsis(core)) continue;
      if (d === "") { op = " "; core = ""; }
      if (op === "+" || op === "-") {
        if (!cur) {
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
    if (cur) {
      // Trailing ctx that runs to EOF belongs to the last run; cap it.
      cur.trailing = cur.trailing.slice(0, 30);
      // The gap ctx before each run doubles as the previous run's trailing.
      // Re-split: run[i].trailing should only extend to the next run's start.
      runs.push(cur);
    }
    // Fix up sharing: trailing of run[i] overlaps leading of run[i+1] by
    // construction (both draw from the same gap buffer) — nothing to do.
    if (!anchored) return null; // pure-add hunk: position unknowable
    return runs;
  }

  // Apply one run at a specific site. Returns {ok, seg, end} where seg
  // replaces lines[loc..end).
  function applyRunAt(lines, loc, run, skipTrailing) {
    var leadLen = run.leading.length;
    var i = loc + leadLen;
    var seg = lines.slice(loc, loc + leadLen);
    var added = 0;
    var removed = 0;
    for (var n = 0; n < run.ops.length; n++) {
      var o = run.ops[n];
      if (o.op === "+") { seg.push(o.line); added++; }
      else if (i < lines.length && anchorEq(lines[i], o.line)) { i++; removed++; }
      else return { ok: false };
    }
    if (!skipTrailing && !contigAt(lines, i, run.trailing)) return { ok: false };
    return { ok: true, seg: seg, end: i, added: added, removed: removed };
  }

  // Independent-run application: each change cluster is anchored and spliced
  // on its own, so hunks whose clusters appear in a different order than the
  // file (or drifted filed order) still resolve. All-or-nothing per event.
  function applyRuns(current, diffLines) {
    var runs = parseRuns(diffLines);
    if (!runs || !runs.length) {
      return { ok: false, reason: "hunk has no anchor lines or bad prefix" };
    }
    var lines = current.slice();
    var added = 0;
    var removed = 0;
    for (var r = 0; r < runs.length; r++) {
      var run = runs[r];
      var cands;
      var insertBefore = false;
      if (run.leading.length) {
        cands = locateSeq(lines, run.leading);
      } else if (run.ops.length && run.ops[0].op === "-") {
        // No leading context: anchor on the first removed line.
        cands = [];
        for (var i = 0; i < lines.length; i++) {
          if (anchorEq(lines[i], run.ops[0].line)) cands.push(i);
        }
        // Reframe: pretend the del line is leading (it will be re-walked).
        if (cands.length) {
          run = { leading: [run.ops[0].line], ops: run.ops.slice(1), trailing: run.trailing };
        }
      } else {
        // Pure-add run: insert before trailing anchor.
        cands = locateSeq(lines, run.trailing);
        insertBefore = true;
      }
      if (!cands.length) return { ok: false, reason: "run " + r + " anchor not found" };
      var done = null;
      if (insertBefore) {
        if (cands.length !== 1) return { ok: false, reason: "run " + r + " add-only hunk anchor ambiguous" };
        var at = cands[0];
        var ins = [];
        for (var q = 0; q < run.ops.length; q++) {
          if (run.ops[q].op !== "+") return { ok: false, reason: "unexpected del in add-only run" };
          ins.push(run.ops[q].line);
          added++;
        }
        lines = lines.slice(0, at).concat(ins, lines.slice(at));
        continue;
      }
      // Phase A: full verify including trailing; exactly one site may verify.
      var verified = [];
      for (var c = 0; c < cands.length; c++) {
        var res = applyRunAt(lines, cands[c], run, false);
        if (res.ok) verified.push({ cand: cands[c], res: res });
      }
      if (verified.length === 1) { done = verified[0]; }
      else if (verified.length > 1) {
        return { ok: false, reason: "run " + r + " anchor ambiguous" };
      } else if (cands.length === 1) {
        // Phase B: trailing mismatch tolerated only at a unique site.
        var rb = applyRunAt(lines, cands[0], run, true);
        if (rb.ok) done = { cand: cands[0], res: rb };
      }
      if (!done) return { ok: false, reason: "run " + r + " of " + runs.length + " does not verify" };
      lines = lines.slice(0, done.cand).concat(done.res.seg, lines.slice(done.res.end));
      added += done.res.added;
      removed += done.res.removed;
    }
    return { ok: true, lines: lines, added: added, removed: removed, matched: 0 };
  }

  function applyDiff(current, bodies) {
    var diffLines = bodies.join("\n").split("\n");
    while (diffLines.length && diffLines[0] === "") diffLines.shift();
    while (diffLines.length && diffLines[diffLines.length - 1] === "") diffLines.pop();
    // A hunk of pure additions has no position info — never "succeed" by
    // prepending it; only the anchored run path may place it (and it fails).
    var anchored = diffLines.some(function (d) {
      var op = d.charAt(0);
      if (op !== " " && op !== "-") return false;
      var core = d.slice(1);
      return !isEllipsis(core);
    });
    var r;
    if (anchored) {
      r = applyOne(current, diffLines, false);
      if (r.ok) { r.method = "stream"; return r; }
      r = applyOne(current, diffLines, true);
      if (r.ok) { r.method = "stream-loose"; return r; }
    }
    r = applyRuns(current, diffLines);
    if (r.ok) { r.method = "runs"; return r; }
    return r;
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
      diffApplied: 0, diffFailed: 0, inferredApplied: 0, pairedEvents: 0,
      byMethod: { stream: 0, "stream-loose": 0, runs: 0 }
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
      if (m.sender !== "assistant") return { uuid: m.uuid, display: m.raw, files: [] };
      var events = tokenize(m.raw);
      if (!events.length) return { uuid: m.uuid, display: m.raw, files: [] };

      var repl = [];
      // Files written/updated by THIS message (latest snapshot wins on repeats).
      var msgFiles = [];
      var msgFileIdx = {};
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
        if (res.method && stats.byMethod[res.method] !== undefined) stats.byMethod[res.method]++;
        var st = states[canon];
        st.lines = res.lines;
        st.revs++;
        st.updatedAt = m.created;
        if (!st.lang) st.lang = inferLang(canon, "");
        var label = ev.displayPath || canon;
        snapFile(canon, label, { kind: "updated", added: res.added, removed: res.removed });
        var tag = ev.path ? "" : " (file inferred)";
        var header = "**" + label + "** — full file (reconstructed from diff" + tag +
          " · rev " + st.revs + " · +" + res.added + "/-" + res.removed + ")";
        var full = header + "\n\n```" + (st.lang || "") + "\n" + res.lines.join("\n") + "\n```";
        repl.push({ start: ev.ranges[0][0], end: ev.ranges[0][1], text: full });
        for (var q = 1; q < ev.ranges.length; q++) {
          repl.push({ start: ev.ranges[q][0], end: ev.ranges[q][1], text: "" });
        }
      });

      if (!repl.length) return { uuid: m.uuid, display: m.raw, files: msgFiles };
      repl.sort(function (a, b) { return a.start - b.start; });
      var s = "";
      var pos = 0;
      repl.forEach(function (rp) {
        s += m.raw.slice(pos, rp.start) + rp.text;
        pos = rp.end;
      });
      s += m.raw.slice(pos);
      return { uuid: m.uuid, display: s, files: msgFiles };
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
