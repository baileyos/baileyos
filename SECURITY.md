# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in BaileyOS, please report it responsibly. Do **not** open a public GitHub issue for security vulnerabilities.

**Email:** security@baileyos.com

### What to include in your report

- A description of the vulnerability
- Steps to reproduce the issue
- The potential impact (what an attacker could do)
- Any suggested fix, if you have one
- Your BaileyOS version and operating system

### What to expect

- We will acknowledge your report within 48 hours
- We will provide an initial assessment within 7 days
- We will work with you to understand and resolve the issue
- We will credit you in the security advisory (unless you prefer to remain anonymous)

### Disclosure timeline

- We ask that you give us 90 days to address the issue before public disclosure
- If the issue is critical and actively exploited, we will work to release a fix as quickly as possible
- We will coordinate with you on the disclosure timeline

## Supported Versions

| Version | Supported |
|---------|-----------|
| Latest release | Yes |
| Previous release | Security fixes only |
| Older versions | No |

## Security Design Principles

BaileyOS is built with the following security principles:

- **Local by default.** The platform does not connect to external servers or cloud services. Your data stays on your network.
- **No telemetry.** There is no usage tracking, analytics, or phone-home behavior.
- **Plugin isolation.** Each device plugin runs in its own context. A compromised plugin cannot access other plugins' data or credentials.
- **No default credentials.** The platform does not ship with default passwords or API keys.
- **Minimal attack surface.** The web dashboard is served on the local network only. It is not exposed to the internet by default.

## Best Practices for Users

- Run BaileyOS on a dedicated machine or VLAN, separate from general-purpose computers
- Do not expose the BaileyOS dashboard to the public internet
- Keep your Node.js installation and system packages up to date
- Review plugin configurations for any credentials or API keys and store them securely
- If using the TTLock plugin (which requires cloud API access), review the TTLock API permissions and use the minimum scope necessary
