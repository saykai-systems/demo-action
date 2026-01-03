# Saykai Demo Action

Public evaluation surface for the Saykai CI safety gate.

This repo is intentionally scoped:
- Included: demo gate Action, Safety Spec format, reporting UX
- Not included: core engine and production policy logic (private)

## What it does

On `pull_request`, this Action:
- reads a Safety Spec YAML
- scans only added lines in the PR for forbidden patterns
- blocks protected path changes unless an approval label is present
- writes `.saykai/report.json` and `.saykai/report.md`

## Quickstart

### 1) Add a spec to your repo

Create `.saykai/spec.yml`:

```yaml
version: "1.0"

rules:
  forbidden_patterns:
    - id: "no-disable-auth"
      pattern: "disable_auth"
      message: "Auth bypass flags are not allowed."

    - id: "no-rm-rf"
      pattern: "rm -rf"
      message: "Destructive commands are blocked."

  protected_paths:
    - id: "prod-config-guard"
      paths:
        - ".github/workflows/"
      message: "Protected paths changed. Requires explicit approval label."
