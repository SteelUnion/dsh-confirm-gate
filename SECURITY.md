# Security Policy

## Supported versions

Only the latest release receives fixes. Older versions are not maintained.

| Version | Supported |
|---|---|
| latest release | yes |
| older | no |

## Reporting a vulnerability

Please do not open a public issue.

Use GitHub private vulnerability reporting:

    https://github.com/SteelUnion/dsh-confirm-gate/security/advisories/new

If that form is unavailable, open an issue that says only "I need a private
contact channel", with no details, and wait for a reply.

## What to include

- plugin version
- DSH version (`dsh --version`)
- what the plugin did, and what you expected
- whether the report involves permissions, the sandbox, or the approval gate

## Scope

This plugin runs inside DeepSeek Harness. Defects in the harness itself belong
to the upstream project. This policy covers only the plugin's own code.
