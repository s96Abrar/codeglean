/* CodeGlean: recover files from web-chat exports. Parse Conversation.json exports, render oldest -> newest. */
(function () {
  "use strict";

  var state = { messages: [], filter: "all", query: "", fileLabel: "", fileStates: null, convSlug: "codeglean", view: "timeline", failures: [] };

  var els = {};
  ["convTitle", "convMeta", "convSummary", "briefToggle", "fileInput", "fileName", "downloadAll",
   "search", "matchCount", "timeline", "diffSection", "senderFilters", "diffCount", "emptyState"].forEach(function (id) {
    els[id] = document.getElementById(id);
  });
  var filterBtns = Array.prototype.slice.call(document.querySelectorAll("#senderFilters button"));
  var viewBtns = Array.prototype.slice.call(document.querySelectorAll("#viewToggle button"));

  els.briefToggle.addEventListener("click", function () {
    var collapsed = els.convSummary.classList.toggle("collapsed");
    els.briefToggle.setAttribute("aria-expanded", String(!collapsed));
  });

  if (window.marked) {
    window.marked.setOptions({ breaks: true, gfm: true });
  }

  function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso || "unknown time";
    return d.toLocaleString();
  }

  function extractRaw(msg) {
    var sender = msg.sender || "unknown";
    var blocks = Array.isArray(msg.content) ? msg.content : [];
    if (sender === "assistant") {
      // Text parts only: ignore thinking / tool_use / tool_result.
      return blocks
        .filter(function (b) { return b && b.type === "text" && typeof b.text === "string"; })
        .map(function (b) { return b.text; })
        .join("\n\n")
        .trim();
    }
    if (typeof msg.text === "string" && msg.text.trim()) return msg.text.trim();
    return blocks
      .filter(function (b) { return b && typeof b.text === "string"; })
      .map(function (b) { return b.text; })
      .join("\n\n")
      .trim();
  }

  function parseData(data, label) {
    if (!data || !Array.isArray(data.chat_messages)) {
      throw new Error("Not a conversation export: missing chat_messages array.");
    }
    var msgs = data.chat_messages.map(function (m) {
      return {
        uuid: m.uuid || "",
        sender: m.sender === "human" ? "human" : "assistant",
        created: m.created_at || "",
        raw: extractRaw(m)
      };
    }).filter(function (m) { return m.raw.length > 0; });

    msgs.sort(function (a, b) {
      return new Date(a.created).getTime() - new Date(b.created).getTime();
    });

    // Reconstruct full files from diffs: each assistant diff block is replaced
    // by the complete file as of that message. Unresolvable diffs keep their
    // original text with a warning note prepended by the resolver.
    var resolveStats = null;
    try {
      if (window.ConversationResolve) {
        var resolved = window.ConversationResolve.resolveAll(msgs);
        var byUuid = new Map();
        resolved.messages.forEach(function (r) { byUuid.set(r.uuid, r); });
        msgs.forEach(function (m) {
          var r = byUuid.get(m.uuid);
          m.display = r ? r.display : m.raw;
          m.files = (r && r.files) || [];
        });
        resolveStats = {
          files: Object.keys(resolved.states).length,
          applied: resolved.stats.diffApplied,
          total: resolved.stats.diffEvents
        };
      }
    } catch (err) {
      resolveStats = null;
    }
    var resolvedStates = (typeof resolved !== "undefined" && resolved && resolveStats)
      ? resolved.states : null;
    if (!resolvedStates) {
      msgs.forEach(function (m) { m.display = m.raw; m.files = []; });
    }
    if (!resolveStats) {
      msgs.forEach(function (m) { m.display = m.raw; m.files = []; });
    } else {
      resolvedStates = resolved.states;
    }

    state.messages = msgs;
    state.fileLabel = label || "";
    state.fileStates = resolvedStates;
    state.convSlug = slugify(data.name);
    var hasFiles = !!(resolvedStates && Object.keys(resolvedStates).length);
    els.downloadAll.disabled = !hasFiles;
    els.downloadAll.title = hasFiles
      ? "Download the newest state of every reconstructed file as a .zip (" +
        Object.keys(resolvedStates).length + " files)"
      : "Load a conversation first";

    var human = msgs.filter(function (m) { return m.sender === "human"; }).length;
    var assistant = msgs.length - human;
    els.convTitle.textContent = data.name || "Conversation";
    renderSidebarStats({
      messages: msgs.length,
      human: human,
      assistant: assistant,
      files: resolveStats ? resolveStats.files : null,
      diffsApplied: resolveStats ? resolveStats.applied : null,
      diffsTotal: resolveStats ? resolveStats.total : null,
      range: data.created_at ? fmtTime(data.created_at) + " → " + fmtTime(data.updated_at) : "",
      file: label || ""
    });
    if (data.summary) {
      els.convSummary.hidden = false;
      els.convSummary.textContent = data.summary;
      // Brief starts collapsed; toggle expands it.
      els.convSummary.classList.add("collapsed");
      els.briefToggle.setAttribute("aria-expanded", "false");
    } else {
      els.convSummary.hidden = true;
    }
    els.fileName.textContent = label || "";
    var failures = (typeof resolved !== "undefined" && resolved && Array.isArray(resolved.failures))
      ? resolved.failures.slice() : [];
    failures.sort(function (a, b) {
      return new Date(a.created).getTime() - new Date(b.created).getTime();
    });
    state.failures = failures;
    els.diffCount.textContent = String(failures.length);
    render();
    setView(state.view);
  }

  function renderSidebarStats(s) {
    function cell(label, value, cls) {
      var c = document.createElement("div");
      c.className = "stat" + (cls ? " " + cls : "");
      var v = document.createElement("div");
      v.className = "stat-v";
      v.textContent = value;
      var k = document.createElement("div");
      k.className = "stat-k";
      k.textContent = label;
      c.appendChild(v);
      c.appendChild(k);
      return c;
    }
    function row(label, value) {
      var r = document.createElement("div");
      r.className = "stat-row";
      var k = document.createElement("span");
      k.className = "stat-rk";
      k.textContent = label;
      var v = document.createElement("span");
      v.className = "stat-rv";
      v.textContent = value;
      v.title = value;
      r.appendChild(k);
      r.appendChild(v);
      return r;
    }
    while (els.convMeta.firstChild) els.convMeta.removeChild(els.convMeta.firstChild);
    var grid = document.createElement("div");
    grid.className = "stat-grid";
    grid.appendChild(cell("Messages", String(s.messages), "is-total"));
    grid.appendChild(cell("Human", String(s.human), "is-human"));
    grid.appendChild(cell("Assistant", String(s.assistant), "is-assistant"));
    els.convMeta.appendChild(grid);
    var rows = document.createElement("div");
    rows.className = "stat-rows";
    rows.appendChild(row("Files", s.files === null ? "—" : String(s.files)));
    var diffs = row("Diffs", s.diffsApplied === null ? "—" : s.diffsApplied + "/" + s.diffsTotal);
    if (s.diffsTotal > 0) {
      var bar = document.createElement("div");
      bar.className = "stat-bar";
      var fill = document.createElement("div");
      fill.className = "stat-fill";
      fill.style.width = Math.round(100 * s.diffsApplied / s.diffsTotal) + "%";
      bar.appendChild(fill);
      diffs.appendChild(bar);
    }
    rows.appendChild(diffs);
    if (s.range) rows.appendChild(row("Range", s.range));
    if (s.file) rows.appendChild(row("File", s.file));
    els.convMeta.appendChild(rows);
  }

  function renderMarkdown(raw) {
    // ponytail: sanitize-or-nothing; raw innerHTML lets a hostile export run JS.
    if (!window.marked || !window.DOMPurify) {
      // Offline fallback: escape + wrap in <pre>.
      var div = document.createElement("div");
      div.textContent = raw;
      return "<pre>" + div.innerHTML + "</pre>";
    }
    return window.DOMPurify.sanitize(window.marked.parse(raw));
  }

  // All code blocks start collapsed; expand per block from the header.

  function codeBlockLang(code) {
    if (!code) return "";
    var m = /language-([\w+-]+)/.exec(code.className || "");
    return m ? m[1] : "";
  }

  // reconstructed: full file rebuilt from an applied diff.
  // unresolved: leftover ```diff fence whose diff could not be applied.
  // original: everything else (new full files, prose snippets, …).
  function codeBlockStatus(pre, lang) {
    if (lang === "diff") return "unresolved";
    var p = pre.previousElementSibling;
    for (var i = 0; i < 3 && p; i++) {
      if (p.tagName === "PRE") break;
      if (/reconstructed from diff/.test(p.textContent || "")) return "reconstructed";
      p = p.previousElementSibling;
    }
    return "original";
  }

  function decorateCodeBlocks(scope) {
    Array.prototype.slice.call(scope.querySelectorAll("pre")).forEach(function (pre) {
      if (pre.parentNode && pre.parentNode.classList &&
          pre.parentNode.classList.contains("codeblock")) return;
      var code = pre.querySelector("code");
      var lang = codeBlockLang(code);
      var text = code ? code.textContent : pre.textContent;
      var lines = text ? text.split("\n").length : 0;
      var status = codeBlockStatus(pre, lang);
      var collapsed = true;

      var wrap = document.createElement("div");
      wrap.className = "codeblock status-" + status + (collapsed ? " collapsed" : "");

      var head = document.createElement("div");
      head.className = "code-head";
      head.setAttribute("role", "button");
      head.setAttribute("tabindex", "0");
      head.setAttribute("aria-expanded", collapsed ? "false" : "true");

      var twistie = document.createElement("span");
      twistie.className = "code-twistie";
      twistie.textContent = ">";
      twistie.setAttribute("aria-hidden", "true");

      var langEl = document.createElement("span");
      langEl.className = "code-lang";
      langEl.textContent = lang || "text";

      var meta = document.createElement("span");
      meta.className = "code-meta";
      meta.textContent = lines + (lines === 1 ? " line" : " lines");

      head.appendChild(twistie);
      head.appendChild(langEl);
      head.appendChild(meta);

      if (status !== "original") {
        var badge = document.createElement("span");
        badge.className = "code-badge " + (status === "reconstructed" ? "ok" : "warn");
        badge.textContent = status === "reconstructed" ? "reconstructed" : "diff · not applied";
        head.appendChild(badge);
      }

      var toggle = document.createElement("button");
      toggle.className = "code-toggle";
      toggle.type = "button";
      toggle.textContent = collapsed ? "Expand" : "Collapse";
      toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");

      var copyBtn = document.createElement("button");
      copyBtn.className = "copy-btn";
      copyBtn.type = "button";
      copyBtn.textContent = "Copy";

      head.appendChild(toggle);
      head.appendChild(copyBtn);
      wrap.appendChild(head);
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);

      function setCollapsed(next) {
        if (next) wrap.classList.add("collapsed");
        else wrap.classList.remove("collapsed");
        toggle.textContent = next ? "Expand" : "Collapse";
        toggle.setAttribute("aria-expanded", next ? "false" : "true");
        head.setAttribute("aria-expanded", next ? "false" : "true");
      }
      function toggleFromHead() {
        setCollapsed(!wrap.classList.contains("collapsed"));
      }
      toggle.addEventListener("click", function (e) {
        e.stopPropagation();
        toggleFromHead();
      });
      // Clicking the header row itself toggles, except on real buttons.
      head.addEventListener("click", function (e) {
        if (e.target && e.target.tagName === "BUTTON") return;
        toggleFromHead();
      });
      head.addEventListener("keydown", function (e) {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          toggleFromHead();
        }
      });
      copyBtn.addEventListener("click", function () {
        var copyText = code ? code.textContent : pre.textContent;
        function done() { copyBtn.textContent = "Copied"; setTimeout(function () { copyBtn.textContent = "Copy"; }, 1200); }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(copyText).then(done, done);
        } else {
          var ta = document.createElement("textarea");
          ta.value = copyText;
          document.body.appendChild(ta);
          ta.select();
          try { document.execCommand("copy"); } catch (e) { /* noop */ }
          document.body.removeChild(ta);
          done();
        }
      });
    });
  }

  function baseName(path) {
    var i = String(path).lastIndexOf("/");
    return i === -1 ? String(path) : String(path).slice(i + 1);
  }

  function triggerBlobDownload(blob, name) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 500);
  }

  function downloadTextFile(path, text) {
    triggerBlobDownload(
      new Blob([text], { type: "text/plain;charset=utf-8" }),
      baseName(path) || "file.txt"
    );
  }

  function slugify(s) {
    return String(s || "codeglean").toLowerCase()
      .replace(/[^a-z0-9-_]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "codeglean";
  }

  // Full conversation files: newest resolved state of every tracked file.
  function downloadAllFiles() {
    var states = state.fileStates;
    if (!states || !Object.keys(states).length) return;
    var paths = Object.keys(states).sort();
    var zipName = (state.convSlug || "codeglean") + "-files.zip";
    if (window.JSZip) {
      try {
        var zip = new window.JSZip();
        paths.forEach(function (p) { zip.file(p, states[p].lines.join("\n")); });
        zip.generateAsync({ type: "blob" }).then(function (blob) {
          triggerBlobDownload(blob, zipName);
        });
        return;
      } catch (err) { /* fall through to individual downloads */ }
    }
    // Offline fallback (no JSZip): one file per download, staggered so the
    // browser registers each click.
    paths.forEach(function (p, i) {
      setTimeout(function () { downloadTextFile(p, states[p].lines.join("\n")); }, i * 300);
    });
  }

  function fileKindLabel(f) {
    if (f.kind === "new") return "new file";
    if (f.kind === "updated") return "+" + f.added + "/−" + f.removed;
    return "full file";
  }

  function buildFilesPanel(files) {
    var aside = document.createElement("aside");
    aside.className = "files";
    aside.setAttribute("aria-label", "Files written in this message");
    var title = document.createElement("div");
    title.className = "files-title";
    title.textContent = "Files · " + files.length;
    aside.appendChild(title);
    var ul = document.createElement("ul");
    files.forEach(function (f) {
      var li = document.createElement("li");
      li.className = "file";
      var info = document.createElement("div");
      info.className = "file-info";
      var name = document.createElement("span");
      name.className = "file-name";
      name.textContent = f.name || baseName(f.path);
      name.title = f.path;
      var meta = document.createElement("span");
      meta.className = "file-meta";
      meta.textContent = [f.lang || "text", f.lines + " lines", "rev " + f.rev, fileKindLabel(f)]
        .join(" · ");
      info.appendChild(name);
      info.appendChild(meta);
      var btn = document.createElement("button");
      btn.className = "dl-btn";
      btn.type = "button";
      btn.textContent = "Download";
      btn.title = "Download " + f.path;
      btn.addEventListener("click", function () { downloadTextFile(f.path, f.text); });
      li.appendChild(info);
      li.appendChild(btn);
      ul.appendChild(li);
    });
    aside.appendChild(ul);
    return aside;
  }

  function setView(v) {
    state.view = (v === "diffs") ? "diffs" : "timeline";
    var inDiffs = state.view === "diffs";
    viewBtns.forEach(function (b) {
      if (b.getAttribute("data-view") === state.view) b.classList.add("active");
      else b.classList.remove("active");
    });
    els.timeline.style.display = inDiffs ? "none" : "";
    els.diffSection.style.display = inDiffs ? "" : "none";
    els.senderFilters.style.display = inDiffs ? "none" : "";
    els.search.style.display = inDiffs ? "none" : "";
    els.matchCount.style.display = inDiffs ? "none" : "";
    if (inDiffs) renderDiffs();
  }

  function renderDiffs() {
    while (els.diffSection.firstChild) els.diffSection.removeChild(els.diffSection.firstChild);
    var list = state.failures.slice().sort(function (a, b) {
      return new Date(a.created).getTime() - new Date(b.created).getTime();
    });
    var head = document.createElement("div");
    head.className = "section-head";
    var title = document.createElement("h2");
    title.textContent = "Unapplied diffs";
    head.appendChild(title);
    var sub = document.createElement("p");
    sub.className = "section-sub";
    sub.textContent = list.length
      ? list.length + (list.length === 1 ? " hunk" : " hunks") +
        " that could not be applied · oldest → newest"
      : "Every diff in this conversation applied cleanly.";
    head.appendChild(sub);
    els.diffSection.appendChild(head);
    if (!list.length) {
      var empty = document.createElement("article");
      empty.className = "card";
      var emptyBody = document.createElement("div");
      emptyBody.className = "body";
      var p = document.createElement("p");
      p.textContent = "Nothing to show — all diffs were reconstructed into full files.";
      emptyBody.appendChild(p);
      empty.appendChild(emptyBody);
      els.diffSection.appendChild(empty);
      return;
    }
    list.forEach(function (f, i) {
      var card = document.createElement("article");
      card.className = "card diff-card";
      var chead = document.createElement("div");
      chead.className = "card-head";
      var badge = document.createElement("span");
      badge.className = "badge warn";
      badge.textContent = "unapplied diff";
      var time = document.createElement("span");
      time.className = "time";
      time.textContent = "#" + (i + 1) + " · " + fmtTime(f.created);
      time.title = f.created || "";
      var path = document.createElement("span");
      path.className = "diff-path";
      path.textContent = f.path || "";
      path.title = f.path || "";
      chead.appendChild(badge);
      chead.appendChild(time);
      chead.appendChild(path);
      card.appendChild(chead);
      var reason = document.createElement("p");
      reason.className = "diff-reason";
      reason.textContent = f.reason || "";
      card.appendChild(reason);
      var body = document.createElement("div");
      body.className = "body";
      body.innerHTML = renderMarkdown("```diff\n" + (f.diff || "") + "\n```");
      card.appendChild(body);
      body.querySelectorAll("pre code").forEach(function (code) {
        if (window.hljs) {
          try { window.hljs.highlightElement(code); } catch (e) { /* noop */ }
        }
      });
      decorateCodeBlocks(body);
      els.diffSection.appendChild(card);
    });
  }

  function render() {
    var q = state.query.toLowerCase();
    var frag = document.createDocumentFragment();
    var shown = 0;

    state.messages.forEach(function (m, i) {
      if (state.filter !== "all" && m.sender !== state.filter) return;
      if (q && m.raw.toLowerCase().indexOf(q) === -1) return;
      shown++;

      var card = document.createElement("article");
      card.className = "card " + m.sender;

      var head = document.createElement("div");
      head.className = "card-head";

      var badge = document.createElement("span");
      badge.className = "badge";
      badge.textContent = m.sender;

      var time = document.createElement("span");
      time.className = "time";
      time.textContent = "#" + (i + 1) + " · " + fmtTime(m.created);
      time.title = m.created || "";

      var uuid = document.createElement("span");
      uuid.className = "uuid";
      uuid.textContent = (m.uuid || "").slice(0, 8);

      var body = document.createElement("div");
      body.className = "body";
      body.innerHTML = renderMarkdown(m.display || m.raw);

      head.appendChild(badge);
      head.appendChild(time);
      head.appendChild(uuid);
      card.appendChild(head);

      var wrap = document.createElement("div");
      wrap.className = "msg-main";
      wrap.appendChild(body);
      if (m.sender === "assistant" && m.files && m.files.length) {
        card.classList.add("has-files");
        wrap.appendChild(buildFilesPanel(m.files));
      }
      card.appendChild(wrap);

      body.querySelectorAll("pre code").forEach(function (code) {
        if (window.hljs) {
          try { window.hljs.highlightElement(code); } catch (e) { /* noop */ }
        }
      });
      decorateCodeBlocks(body);
      frag.appendChild(card);
    });

    els.timeline.replaceChildren(frag);
    els.emptyState.style.display = state.messages.length ? "none" : "";
    els.matchCount.textContent = state.messages.length
      ? shown + " of " + state.messages.length + " shown"
      : "";
  }

  function loadFile(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        parseData(JSON.parse(reader.result), file.name);
      } catch (err) {
        els.convMeta.textContent = "Could not parse file: " + err.message;
      }
    };
    reader.readAsText(file);
  }

  els.fileInput.addEventListener("change", function (e) {
    if (e.target.files && e.target.files[0]) loadFile(e.target.files[0]);
  });

  filterBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      filterBtns.forEach(function (b) { b.classList.remove("active"); });
      btn.classList.add("active");
      state.filter = btn.getAttribute("data-filter");
      render();
    });
  });

  els.search.addEventListener("input", function (e) {
    state.query = e.target.value.trim();
    render();
  });

  els.downloadAll.addEventListener("click", downloadAllFiles);

  viewBtns.forEach(function (btn) {
    btn.addEventListener("click", function () {
      setView(btn.getAttribute("data-view"));
    });
  });
  setView("timeline");

  ["dragover", "dragenter"].forEach(function (evt) {
    window.addEventListener(evt, function (e) {
      e.preventDefault();
      document.body.classList.add("dragover");
    });
  });
  ["dragleave", "drop"].forEach(function (evt) {
    window.addEventListener(evt, function (e) {
      e.preventDefault();
      if (evt === "drop" && e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        loadFile(e.dataTransfer.files[0]);
      }
      document.body.classList.remove("dragover");
    });
  });

  if (!window.marked || !window.DOMPurify || !window.hljs || !window.JSZip) {
    console.warn("[CodeGlean] a vendor script failed to load; rendering degraded:",
      "marked=" + !!window.marked, "DOMPurify=" + !!window.DOMPurify,
      "hljs=" + !!window.hljs, "JSZip=" + !!window.JSZip);
  }

  // Auto-load a sibling export from the current directory when served over
  // http(s). Tries both casings (Conversation.json / conversation.json),
  // then falls back to the bundled sample so fresh clones and GitHub Pages
  // deployments show a working demo with zero setup.
  // Note: browsers block fetch() from file:// — open via a local server
  // (e.g. `npx serve .`) or use Choose JSON / drag & drop instead.
  function tryFetch(urls) {
    if (!urls.length) return Promise.reject(new Error("no local file"));
    return fetch(urls[0]).then(function (r) {
      if (!r.ok) throw new Error("not found");
      return r.json().then(function (data) { return { data: data, label: urls[0].slice(2) }; });
    }).catch(function () { return tryFetch(urls.slice(1)); });
  }
  tryFetch(["./Conversation.json", "./conversation.json", "./sample-conversation.json"])
    .then(function (loaded) { parseData(loaded.data, loaded.label); })
    .catch(function () { /* stay on empty state; user picks a file */ });
})();
