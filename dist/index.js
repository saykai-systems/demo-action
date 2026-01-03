"use strict";

/*
  Saykai Gate - Demo Surface (Public)

  Goals:
  - Demonstrate spec-driven CI gating with crisp UX
  - Do not reveal any proprietary core engine logic
  - Look "real": file+line annotations, job summary, reports

  Behavior:
  - Runs on pull_request (skips otherwise)
  - Loads .saykai/spec.yml (or input spec_path)
  - Validates minimal spec structure
  - Checks:
      1) forbidden_patterns: scans ONLY added lines in PR diffs
      2) protected_paths: blocks changes to protected paths unless PR has required label
  - Writes:
      .saykai/report.json
      .saykai/report.md
*/

const fs = require("fs");
const path = require("path");
const cp = require("child_process");

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

function fail(msg) {
  error(msg);
  process.exit(1);
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
  return cp.execSync(cmd, { stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
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

  This is intentionally not a full YAML implementation.
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

(function main() {
  const specPath = getInput("spec_path", ".saykai/spec.yml");
  const requiredLabel = getInput("required_label", "saykai-approved");
  const maxFilesScanned = toInt(getInput("max_files_scanned", "200"), 200);

  appendSummary("# Saykai Gate - Demo Surface\n");
  appendSummary(`- Spec: \`${specPath}\``);
  appendSummary(`- Required label for protected paths: \`${requiredLabel}\``);

  if (!fs.existsSync(specPath)) {
    fail(`Missing Safety Spec at ${specPath}. Add one or set inputs.spec_path.`);
  }

  const specText = fs.readFileSync(specPath, "utf8");
  const spec = parseDemoYaml(specText);
  const specErrors = validateSpec(spec);

  if (specErrors.length) {
    appendSummary("\n## Spec validation\n");
    for (const e of specErrors) appendSummary(`- ${e}`);
    fail("Invalid Safety Spec. Fix spec format.");
  }

  const payload = getPRPayload();
  if (!payload) {
    warn("Designed for pull_request events. Skipping.");
    appendSummary("\n> Skipped: not a pull_request event.\n");
    process.exit(0);
  }

  const range = computeRange(payload);
  if (!range) fail("Unable to compute diff range for PR.");

  const labels = getPRLabels(payload);
  const changedFilesAll = listChangedFiles(range.base, range.head);
  const changedFilesEvaluated = changedFilesAll.slice(0, maxFilesScanned);

  appendSummary("\n## Change set\n");
  appendSummary(`- Files changed: **${changedFilesAll.length}** (evaluating up to **${changedFilesEvaluated.length}**)`);
  appendSummary(`- PR labels: ${labels.length ? labels.map((l) => `\`${l}\``).join(", ") : "_none_"}`);

  const reportDir = ".saykai";
  ensureDir(reportDir);

  const report = {
    gate: "saykai-demo",
    spec_version: spec.version,
    pr: {
      number: payload.pull_request.number,
      title: payload.pull_request.title,
      labels
    },
    diff: {
      base: range.base,
      head: range.head,
      changed_files: changedFilesAll
    },
    results: {
      passed: true,
      failures: []
    }
  };

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

  // Write reports
  const jsonPath = path.join(reportDir, "report.json");
  writeFile(jsonPath, JSON.stringify(report, null, 2));

  const mdLines = [];
  mdLines.push("# Saykai Demo Gate report");
  mdLines.push("");
  mdLines.push(`- Spec version: ${spec.version}`);
  mdLines.push(`- PR: #${report.pr.number} - ${report.pr.title}`);
  mdLines.push(`- Labels: ${labels.length ? labels.join(", ") : "none"}`);
  mdLines.push("");

  if (report.results.passed) {
    mdLines.push("## Result");
    mdLines.push("PASS");
  } else {
    mdLines.push("## Result");
    mdLines.push("BLOCK");
    mdLines.push("");
    mdLines.push("## Failures");
    for (const f of report.results.failures) {
      if (f.type === "forbidden_pattern") {
        mdLines.push(
          `- Forbidden pattern \`${f.pattern}\` in \`${f.file}:${f.line}\` (rule: \`${f.rule_id}\`)`
        );
      } else if (f.type === "protected_paths") {
        mdLines.push(
          `- Protected paths changed without label \`${f.required_label}\` (rule: \`${f.rule_id}\`)`
        );
        mdLines.push(
          `  - Files: ${f.touched_files.slice(0, 20).join(", ")}${f.touched_files.length > 20 ? " ..." : ""}`
        );
      }
    }
  }

  const mdPath = path.join(reportDir, "report.md");
  writeFile(mdPath, mdLines.join("\n") + "\n");

  // Job summary
  appendSummary("\n## Gate result\n");
  if (report.results.passed) {
    appendSummary("- Status: **PASS**");
    appendSummary(`- Report: \`${jsonPath}\` and \`${mdPath}\``);
    out("Saykai Demo Gate: PASS");
    process.exit(0);
  }

  appendSummary("- Status: **BLOCK**");
  appendSummary(`- Failures: **${report.results.failures.length}**`);
  appendSummary(`- Report: \`${jsonPath}\` and \`${mdPath}\``);

  appendSummary("\n### Failures (top)\n");
  for (const f of report.results.failures.slice(0, 10)) {
    if (f.type === "forbidden_pattern") {
      appendSummary(`- Forbidden pattern \`${f.pattern}\` in \`${f.file}:${f.line}\` (rule: \`${f.rule_id}\`)`);
    } else if (f.type === "protected_paths") {
      appendSummary(`- Protected paths changed without label \`${f.required_label}\` (rule: \`${f.rule_id}\`)`);
    }
  }

  fail("Saykai Demo Gate blocked this change. See job summary and .saykai reports.");
})();
EOF