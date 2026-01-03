# Saykai Demo Action

Public evaluation surface for the Saykai CI safety gate.

This repo is intentionally scoped:
- Included: demo gate Action, Safety Spec format, reporting UX
- Not included: core engine and production policy logic (private)

## What it does

On pull_request:
- reads a Safety Spec YAML
- scans only added lines in the PR for forbidden patterns
- blocks protected path changes unless an approval label is present
- writes `.saykai/report.json` and `.saykai/report.md`

## Quickstart

1) Add a spec to your repo

Create `.saykai/spec.yml`:

```yaml
version: "1.0"
rules:
  forbidden_patterns:
    - id: "no-disable-auth"
      pattern: "disable_auth"
      message: "Auth bypass flags are not allowed."
  protected_paths:
    - id: "prod-config-guard"
      paths:
        - ".github/workflows/"
      message: "Protected paths changed. Requires explicit approval label."

name: Saykai Demo Gate

on:
  pull_request:

jobs:
  gate:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0

      - name: Saykai Demo Gate
        uses: saykai-systems/demo-action@v1
        with:
          spec_path: .saykai/spec.yml
          required_label: saykai-approved

      - name: Upload Saykai report
        if: always()
        uses: actions/upload-artifact@v4
        with:
          name: saykai-report
          path: .saykai/



cat > SECURITY.md <<'EOF'
# Security

This repository is a demo surface and should not be used to protect production systems.

If you believe you have found a security issue, do not open a public issue.
Use the contact method in SUPPORT.md.
