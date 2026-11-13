# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.1.x   | :white_check_mark: |
| < 0.1.0 | :x:                |

## Security Design Principles

Filaxis is a remote execution and terminal runtime SDK (`local` / `ssh` / `tmux`). By design, it enforces the following boundaries:

- **Host Key Verification**: Defaults to TOFU (`accept-new`). For high-security environments, configure `hostKeyPolicy: "strict"` with an explicit `knownHostsFile`.
- **Credential Handling**: Only credential file paths (e.g., SSH private key paths) are passed to transport commands; raw secrets and private key contents are never embedded in logs, error messages, or serialized state.
- **Zero Runtime Dependencies**: Core runtime relies strictly on `node:` standard library APIs with zero third-party npm runtime dependencies, minimizing supply-chain attack surface.

## Reporting a Vulnerability

The Filaxis team takes security issues seriously. If you discover a security vulnerability in this project, please report it **privately**:

1. **GitHub Private Vulnerability Reporting (Recommended)**:  
   Navigate to the [Security Advisories](https://github.com/corolin/filaxis/security/advisories/new) tab in this repository and click **"Report a vulnerability"**. This allows us to review and fix the issue before public disclosure.

2. **Direct Contact**:  
   If you cannot use GitHub Security Advisories, please contact the repository maintainer directly.

### What to include in your report:
- A clear description of the vulnerability and affected transport/module (`local`, `ssh`, `tmux`, `file-transfer`, etc.).
- Steps to reproduce or proof-of-concept (PoC) code.
- Potential impact and attack scenarios.
- Suggested mitigation (if any).

We will acknowledge receipt within 48 hours and work with you on a resolution and coordinated public disclosure.
