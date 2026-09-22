#!/usr/bin/env node
/* Node CLI: reconstruct every file from a Conversation.json export without a
 * browser. Thin wrapper around resolve.js's resolution pipeline (same logic
 * app.js uses in-browser) — reads the export, resolves it, writes the newest
 * state of every file to disk (or a .zip), and reports whatever couldn't be
 * resolved so a human can reconcile it manually.
 *
 * Usage: node reconstruct.js <conversation.json> [--out <dir>] [--zip]
 */
"use strict";

var fs = require("fs");
var path = require("path");
var resolve = require("./resolve.js");

function usage(msg) {
  if (msg) console.error(msg);
  console.error("Usage: node reconstruct.js <conversation.json> [--out <dir>] [--zip]");
  process.exit(1);
}

function parseArgs(argv) {
  var input = null, outDir = "out", zip = false;
  for (var i = 0; i < argv.length; i++) {
    var a = argv[i];
    if (a === "--out") { outDir = argv[++i]; if (!outDir) usage("--out requires a directory"); }
    else if (a === "--zip") { zip = true; }
    else if (!input) { input = a; }
    else usage("Unexpected argument: " + a);
  }
  if (!input) usage();
  return { input: input, outDir: outDir, zip: zip };
}

function writeFileDeep(filePath, content) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function buildManifest(failures) {
  var lines = ["# Unresolved diffs", "", failures.length
    ? failures.length + " diff(s) could not be applied automatically."
    : "None — every diff applied cleanly.", ""];
  failures.forEach(function (f) {
    lines.push("## " + f.path);
    lines.push("- message: " + f.uuid + " @ " + f.created);
    lines.push("- reason: " + f.reason);
    lines.push("");
  });
  return lines.join("\n");
}

function rejContent(f) {
  return "# Unapplied diff for " + f.path + "\n" +
    "# message: " + f.uuid + " @ " + f.created + "\n" +
    "# reason: " + f.reason + "\n\n" + f.diff + "\n";
}

function main() {
  var args = parseArgs(process.argv.slice(2));
  var data = JSON.parse(fs.readFileSync(args.input, "utf8"));
  var msgs = resolve.extractMessages(data);
  var res = resolve.resolveAll(msgs);
  var paths = Object.keys(res.states).sort();

  var manifest = buildManifest(res.failures);

  if (args.zip) {
    var JSZip = require("./vendor/jszip.min.js");
    var zip = new JSZip();
    paths.forEach(function (p) { zip.file(p, res.states[p].lines.join("\n")); });
    res.failures.forEach(function (f, i) { zip.file(f.path + "." + i + ".rej", rejContent(f)); });
    zip.file("UNRESOLVED.md", manifest);
    zip.generateAsync({ type: "nodebuffer" }).then(function (buf) {
      fs.mkdirSync(args.outDir, { recursive: true });
      var zipPath = path.join(args.outDir, "reconstructed.zip");
      fs.writeFileSync(zipPath, buf);
      report(paths.length, res.failures.length, zipPath);
    });
  } else {
    paths.forEach(function (p) {
      writeFileDeep(path.join(args.outDir, p), res.states[p].lines.join("\n"));
    });
    res.failures.forEach(function (f, i) {
      writeFileDeep(path.join(args.outDir, f.path + "." + i + ".rej"), rejContent(f));
    });
    writeFileDeep(path.join(args.outDir, "UNRESOLVED.md"), manifest);
    report(paths.length, res.failures.length, args.outDir);
  }
}

function report(fileCount, failCount, dest) {
  console.log(fileCount + " file(s) reconstructed to " + dest +
    (failCount ? ", " + failCount + " diff(s) unresolved (see UNRESOLVED.md)" : ""));
  if (failCount) process.exitCode = 1;
}

main();
