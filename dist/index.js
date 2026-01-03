"use strict";

/*
  Saykai Gate - Demo Surface (Public)

  Goals
  - Demonstrate spec-driven CI gating with crisp UX
  - Do not reveal any proprietary core engine logic
  - Look real: file+line annotations, job summary, reports

  Behavior
  - Runs on pull_request (skips otherwise)
  - Loads .saykai/spec.yml (or input spec_path)
  - Validates minimal spec structure
  - Checks:
      1) forbidden_patterns: scans ONLY added lines in PR diffs
      2) protected_paths: blocks changes to protected paths unless PR has required label
  - Writes (to the repo workspace):
      .saykai/report.json
      .saykai/report.md

  Important
  - Node actions run from the action install directory by default, not the repo.
    This file forces all IO and git commands to run inside GITHUB_WORKSPACE so
    upload-artifact can find .saykai/.
*/

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

// Always operate in the checked-out repository workspace.
const WORKDIR = process.env.GITHUB_WORKSPACE || process.cwd();
try {
  process.chdir(WORKDIR);
} catch {
  // If chdir fails, we'll still attempt to run, but artifacts may not upload.
}

function out(msg) {
  process.stdout.write(`${msg}\n`);
}

function warn(msg) {
  process.stdout.write(`::warning title=Saykai Demo Gate::${String(msg).replace(/[\r\n]/g, " ")}\n`);
}

function error(msg) {
  process.stdout.write(`::error title=Saykai Demo Gate::${String(msg).replace(/[\r\n]/g, " ")}\n`);
}

function errorAt(file, line, msg) {
  const safeFile = String(file || "").replace(/[\r\n]/g, "");
  const safeMsg = String(msg || "").replace(/[\r\n]/g, " ");
  const safeLine = Number.isFinite(line) && line > 0 ? `,line=${line}` : "";
  process.stdout.write(`::error file=${safeFile}${safeLine},title=Saykai Demo Gate::${safeMsg}\n`);
}

function getInput(name, fallback) {
  const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
  return (process.env[key] || fallback || "").trim();
}

function toInt(v, fallback) {
  const n = parseInt(String(v), 10);
  return Number.isFinite(n) ? n : fallback;
}

function sh(cmd) {
  // Run commands in the repo workspace, not the action directory.
  return cp.execSync(cmd, { cwd: WORKDIR, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
}

function safeReadJSON(p) {
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeFile(p, contents) {
  ensureDir(path.dirname(p));
  fs.writeFileSync(p, contents, "utf8");
}

function appendSummary(md) {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) return;
  fs.appendFileSync(summaryPath, md + "\n", "utf8");
}

/*
  Minimal YAML parser for this spec shape only.
  Supports:
  - key: value
  - nested maps by indentation
  - arrays of objects using "- key: value" followed by indented keys
  - arrays of strings using "- value"

  Intentionally not a full YAML implementation.
*/
function parseDemoYaml(yamlText) {
  const lines = yamlText
    .split("\n")
    .map((l) => l.replace(/\t/g, "  "))
    .filter((l) => !l.trim().startsWith("#"));

  const root = {};
  const stack = [{ indent: -1, obj: root }];

  function parseScalar(raw) {
    const t = raw.trim();
    if (t === "true") return true;
    if (t === "false") return false;
    if (/^".*"$/.test(t)) return t.slice(1, -1);
    if (/^'.*'$/.test(t)) return t.slice(1, -1);
    return t;
  }

  for (const line of lines) {
    if (!line.trim()) continue;

    const indent = line.match(/^ */)[0].length;
    const trimmed = line.trim();

    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) {
      stack.pop();
    }
    const cur = stack[stack.length - 1].obj;

    if (trimmed.startsWith("- ")) {
      if (!Array.isArray(cur.__list)) cur.__list = [];
      const rest = trimmed.slice(2);

      if (rest.includes(":")) {
        const idx = rest.indexOf(":");
        const k = rest.slice(0, idx).trim();
        const v = rest.slice(idx + 1).trim();
        const itemObj = {};
        itemObj[k] = parseScalar(v);
        cur.__list.push(itemObj);
        stack.push({ indent, obj: itemObj });
      } else {
        cur.__list.push(parseScalar(rest));
      }
      continue;
    }

    if (trimmed.includes(":")) {
      const idx = trimmed.indexOf(":");
      const k = trimmed.slice(0, idx).trim();
      const v = trimmed.slice(idx + 1).trim();

      if (v === "") {
        const child = {};
        cur[k] = child;
        stack.push({ indent, obj: child });
      } else {
        cur[k] = parseScalar(v);
      }
    }
  }

  function normalize(node) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(normalize);

    const outObj = {};
    for (const [k, v] of Object.entries(node)) {
      if (k === "__list") continue;
      outObj[k] = normalize(v);
    }

    if (Array.isArray(node.__list)) {
      const hasKeys = Object.keys(outObj).length > 0;
      if (hasKeys) outObj.items = normalize(node.__list);
      else return normalize(node.__list);
    }

    return outObj;
  }

  return normalize(root);
}

function validateSpec(spec) {
  const errs = [];
  if (!spec || typeof spec !== "object") errs.push("Spec is not an object.");
  if (!spec.version || typeof spec.version !== "string") errs.push("Missing spec.version string.");
  if (!spec.rules || typeof spec.rules !== "object") errs.push("Missing spec.rules object.");

  const rules = (spec && spec.rules) || {};
  if (!Array.isArray(rules.forbidden_patterns)) errs.push("rules.forbidden_patterns must be an array.");
  if (!Array.isArray(rules.protected_paths)) errs.push("rules.protected_paths must be an array.");

  for (const r of rules.forbidden_patterns || []) {
    if (!r.id || !r.pattern || !r.message) {
      errs.push("Each forbidden_patterns rule must include id, pattern, message.");
      break;
    }
  }

  for (const r of rules.protected_paths || []) {
    if (!r.id || !Array.isArray(r.paths) || r.paths.length < 1 || !r.message) {
      errs.push("Each protected_paths rule must include id, paths[], message.");
      break;
    }
  }

  return errs;
}

function getPRPayload() {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) return null;
  const payload = safeReadJSON(eventPath);
  if (!payload || !payload.pull_request) return null;
  return payload;
}

function computeRange(payload) {
  const base = payload.pull_request.base && payload.pull_request.base.sha;
  const head = payload.pull_request.head && payload.pull_request.head.sha;
  if (!base || !head) return null;
  return { base, head };
}

function listChangedFiles(base, head) {
  try {
    sh("git fetch --no-tags --prune --depth=200 origin");
  } catch {
    // ignore
  }
  const outText = sh(`git diff --name-only ${base} ${head}`).trim();
  if (!outText) return [];
  return outText.split("\n").map((s) => s.trim()).filter(Boolean);
}

function getPRLabels(payload) {
  return (payload.pull_request.labels || [])
    .map((l) => (l && l.name ? String(l.name) : ""))
    .filter(Boolean);
}

function isUnderAnyPrefix(filePath, prefixes) {
  const norm = filePath.replace(/\\/g, "/");
  return prefixes.some((p) => {
    const pp = String(p).replace(/\\/g, "/").replace(/\/+$/, "");
    return norm === pp || norm.startsWith(pp + "/");
  });
}

/*
  Parse unified diff to inspect only added lines with file + line numbers.
  Uses `git diff -U0` for compact hunks.
*/
function scanAddedLinesForPatterns(base, head, patterns) {
  const diff = sh(`git diff -U0 ${base} ${head}`);
  const lines = diff.split("\n");

  let curFile = null;
  let newLine = null;
  const hits = [];

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      curFile = null;
      newLine = null;
      continue;
    }

    if (line.startsWith("+++ b/")) {
      curFile = line.slice("+++ b/".length).trim();
      continue;
    }

    if (line.startsWith("@@")) {
      const m = line.match(/\+(\d+)(?:,(\d+))?/);
      newLine = m ? parseInt(m[1], 10) : null;
      continue;
    }

    // Added line (ignore +++ file header)
    if (line.startsWith("+") && !line.startsWith("+++")) {
      const content = line.slice(1);
      if (curFile && Number.isFinite(newLine)) {
        for (const rule of patterns) {
          if (!rule || !rule.pattern) continue;
          if (content.includes(rule.pattern)) {
            hits.push({
              type: "forbidden_pattern",
              rule_id: rule.id,
              pattern: rule.pattern,
              message: rule.message,
              file: curFile,
              line: newLine,
              sample: content.slice(0, 200)
            });
          }
        }
      }
      if (Number.isFinite(newLine)) newLine += 1;
      continue;
    }

    // Removed line does not advance newLine
    if (line.startsWith("-") && !line.startsWith("---")) {
      continue;
    }
  }

  return hits;
}

function writeReportFiles(reportDirAbs, report) {
  ensureDir(reportDirAbs);

  const jsonPathAbs = path.join(reportDirAbs, "report.json");
  writeFile(jsonPathAbs, JSON.stringify(report, null, 2));

  const mdLines = [];
  mdLines.push("# Saykai Demo Gate report");
  mdLines.push("");
  mdLines.push(`- Spec version: ${report.spec_version || "unknown"}`);
  if (report.pr && report.pr.number != null) mdLines.push(`- PR: #${report.pr.number} - ${report.pr.title || ""}`.trim());
  mdLines.push(`- Labels: ${(report.pr && report.pr.labels && report.pr.labels.length) ? report.pr.labels.join(", ") : "none"}`);
  mdLines.push("");

  if (report.results && report.results.passed) {
    mdLines.push("## Result");
    mdLines.push("PASS");
  } else {
    mdLines.push("## Result");
    mdLines.push("BLOCK");
    mdLines.push("");

    if (report.results && Array.isArray(report.results.failures) && report.results.failures.length) {
      mdLines.push("## Failures");
      for (const f of report.results.failures) {
        if (f.type === "forbidden_pattern") {
          mdLines.push(`- Forbidden pattern \`${f.pattern}\` in \`${f.file}:${f.line}\` (rule: \`${f.rule_id}\`)`);
        } else if (f.type === "protected_paths") {
          mdLines.push(`- Protected paths changed without label \`${f.required_label}\` (rule: \`${f.rule_id}\`)`);
          mdLines.push(
            `  - Files: ${f.touched_files.slice(0, 20).join(", ")}${f.touched_files.length > 20 ? " ..." : ""}`
          );
        } else if (f.type === "fatal") {
          mdLines.push(`- ${f.message}`);
        }
      }
    }
  }

  const mdPathAbs = path.join(reportDirAbs, "report.md");
  writeFile(mdPathAbs, mdLines.join("\n") + "\n");

  // Return repo-relative paths (for job summary readability)
  const jsonPathRel = path.relative(WORKDIR, jsonPathAbs).replace(/\\/g, "/");
  const mdPathRel = path.relative(WORKDIR, mdPathAbs).replace(/\\/g, "/");
  return { jsonPathRel, mdPathRel };
}

(function main() {
  const specPathInput = getInput("spec_path", ".saykai/spec.yml");
  const requiredLabel = getInput("required_label", "saykai-approved");
  const maxFilesScanned = toInt(getInput("max_files_scanned", "200"), 200);

  const specPathAbs = path.isAbsolute(specPathInput) ? specPathInput : path.join(WORKDIR, specPathInput);
  const reportDirAbs = path.join(WORKDIR, ".saykai");

  appendSummary("# Saykai Gate - Demo Surface\n");
  appendSummary(`- Workspace: \`${WORKDIR}\``);
  appendSummary(`- Spec: \`${specPathInput}\``);
  appendSummary(`- Required label for protected paths: \`${requiredLabel}\``);

  const payload = getPRPayload();
  if (!payload) {
    warn("Designed for pull_request events. Skipping.");
    appendSummary("\n> Skipped: not a pull_request event.\n");
    process.exit(0);
  }

  // Build a report object early so we can always write artifacts on failures.
  const report = {
    gate: "saykai-demo",
    spec_version: "unknown",
    pr: {
      number: payload.pull_request.number,
      title: payload.pull_request.title,
      labels: []
    },
    diff: {
      base: null,
      head: null,
      changed_files: []
    },
    results: {
      passed: true,
      failures: []
    }
  };

  const labels = getPRLabels(payload);
  report.pr.labels = labels;

  const range = computeRange(payload);
  if (!range) {
    report.results.passed = false;
    report.results.failures.push({ type: "fatal", message: "Unable to compute diff range for PR." });
    const paths = writeReportFiles(reportDirAbs, report);
    appendSummary("\n## Gate result\n- Status: **BLOCK**");
    appendSummary(`- Report: \`${paths.jsonPathRel}\` and \`${paths.mdPathRel}\``);
    error("Unable to compute diff range for PR.");
    process.exit(1);
  }

  report.diff.base = range.base;
  report.diff.head = range.head;

  if (!fs.existsSync(specPathAbs)) {
    report.results.passed = false;
    report.results.failures.push({
      type: "fatal",
      message: `Missing Safety Spec at ${specPathInput}. Add one or set inputs.spec_path.`
    });
    const paths = writeReportFiles(reportDirAbs, report);
    appendSummary("\n## Gate result\n- Status: **BLOCK**");
    appendSummary(`- Report: \`${paths.jsonPathRel}\` and \`${paths.mdPathRel}\``);
    error(`Missing Safety Spec at ${specPathInput}. Add one or set inputs.spec_path.`);
    process.exit(1);
  }

  const specText = fs.readFileSync(specPathAbs, "utf8");
  const spec = parseDemoYaml(specText);
  const specErrors = validateSpec(spec);

  if (specErrors.length) {
    report.results.passed = false;
    report.results.failures.push({ type: "fatal", message: "Invalid Safety Spec. Fix spec format." });
    report.results.failures.push(...specErrors.map((e) => ({ type: "fatal", message: e })));

    const paths = writeReportFiles(reportDirAbs, report);

    appendSummary("\n## Spec validation\n");
    for (const e of specErrors) appendSummary(`- ${e}`);

    appendSummary("\n## Gate result\n- Status: **BLOCK**");
    appendSummary(`- Report: \`${paths.jsonPathRel}\` and \`${paths.mdPathRel}\``);

    error("Invalid Safety Spec. Fix spec format.");
    process.exit(1);
  }

  report.spec_version = spec.version;

  const changedFilesAll = listChangedFiles(range.base, range.head);
  const changedFilesEvaluated = changedFilesAll.slice(0, maxFilesScanned);
  report.diff.changed_files = changedFilesAll;

  appendSummary("\n## Change set\n");
  appendSummary(`- Files changed: **${changedFilesAll.length}** (evaluating up to **${changedFilesEvaluated.length}**)`);
  appendSummary(`- PR labels: ${labels.length ? labels.map((l) => `\`${l}\``).join(", ") : "_none_"}`);

  // Check 1: Forbidden patterns (added lines only)
  const forbiddenRules = spec.rules.forbidden_patterns || [];
  const forbiddenHits = scanAddedLinesForPatterns(range.base, range.head, forbiddenRules);

  for (const hit of forbiddenHits) {
    report.results.passed = false;
    report.results.failures.push(hit);
    errorAt(hit.file, hit.line, `${hit.message} (rule: ${hit.rule_id}, pattern: "${hit.pattern}")`);
  }

  // Check 2: Protected paths require label
  const protectedRules = spec.rules.protected_paths || [];
  const hasRequiredLabel = labels.includes(requiredLabel);

  for (const rule of protectedRules) {
    const touched = changedFilesAll.filter((f) => isUnderAnyPrefix(f, rule.paths));
    if (touched.length > 0 && !hasRequiredLabel) {
      report.results.passed = false;
      report.results.failures.push({
        type: "protected_paths",
        rule_id: rule.id,
        message: rule.message,
        required_label: requiredLabel,
        touched_files: touched
      });
      error(`${rule.message} (rule: ${rule.id}, required label: "${requiredLabel}")`);
    }
  }

  // Always write reports to the repo workspace so upload-artifact can find them.
  const paths = writeReportFiles(reportDirAbs, report);

  // Job summary
  appendSummary("\n## Gate result\n");
  if (report.results.passed) {
    appendSummary("- Status: **PASS**");
    appendSummary(`- Report: \`${paths.jsonPathRel}\` and \`${paths.mdPathRel}\``);
    out("Saykai Demo Gate: PASS");
    process.exit(0);
  }

  appendSummary("- Status: **BLOCK**");
  appendSummary(`- Failures: **${report.results.failures.length}**`);
  appendSummary(`- Report: \`${paths.jsonPathRel}\` and \`${paths.mdPathRel}\``);

  appendSummary("\n### Failures (top)\n");
  for (const f of report.results.failures.slice(0, 10)) {
    if (f.type === "forbidden_pattern") {
      appendSummary(`- Forbidden pattern \`${f.pattern}\` in \`${f.file}:${f.line}\` (rule: \`${f.rule_id}\`)`);
    } else if (f.type === "protected_paths") {
      appendSummary(`- Protected paths changed without label \`${f.required_label}\` (rule: \`${f.rule_id}\`)`);
    } else if (f.type === "fatal") {
      appendSummary(`- ${f.message}`);
    }
  }

  error("Saykai Demo Gate blocked this change. See job summary and .saykai reports.");
  process.exit(1);
})();
