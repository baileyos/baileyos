# Contributing to BaileyOS

Thank you for your interest in contributing to BaileyOS. This document explains the process for contributing code, documentation, and device plugins.

## Getting Started

1. **Fork the repository** on GitHub
2. **Clone your fork** locally:
   ```bash
   git clone https://github.com/YOUR-USERNAME/baileyos-community.git
   cd baileyos-community
   ```
3. **Install dependencies:**
   ```bash
   npm install
   ```
4. **Create a branch** for your work:
   ```bash
   git checkout -b your-branch-name
   ```

## Development Workflow

1. Make your changes on your feature branch
2. Write or update tests as needed
3. Run the test suite to verify nothing is broken:
   ```bash
   npm test
   ```
4. Run the linter:
   ```bash
   npm run lint
   ```
5. Commit your changes with a clear, descriptive message
6. Push your branch to your fork
7. Open a pull request against the `main` branch

## Pull Request Guidelines

- **One feature or fix per PR.** Keep pull requests focused. If you have multiple unrelated changes, submit them as separate PRs.
- **Write a clear description.** Explain what the PR does, why the change is needed, and how it was tested.
- **Include tests.** New features and bug fixes should include test coverage. Plugins should include at least basic unit tests for their protocol handling.
- **Follow existing patterns.** Look at how existing plugins and modules are structured and follow the same conventions.
- **Keep commits clean.** Squash work-in-progress commits before submitting. Each commit in the PR should represent a logical unit of work.

## Code Style

- **Language:** TypeScript (strict mode)
- **Formatting:** Use the project's Prettier configuration (`npm run format`)
- **Naming:**
  - Files: `kebab-case.ts`
  - Classes: `PascalCase`
  - Functions and variables: `camelCase`
  - Constants: `UPPER_SNAKE_CASE`
- **Imports:** Use named imports. Avoid default exports where possible.
- **Error handling:** Always handle errors explicitly. Do not swallow exceptions silently.
- **Logging:** Use the project logger (`import { logger } from '../core/logger'`), not `console.log`.

## Writing a Device Plugin

Device plugins are the most common type of contribution. Each plugin lives in its own folder under `plugins/` and follows a standard structure.

See [docs/creating-a-plugin.md](docs/creating-a-plugin.md) for the full guide on writing a device plugin, including:

- Plugin folder structure
- Required exports and lifecycle hooks
- Device registration
- API route conventions
- State management and SSE events
- Testing your plugin

## Reporting Bugs

Open a GitHub issue with:

- A clear title describing the problem
- Steps to reproduce the issue
- Expected behavior vs. actual behavior
- Your OS, Node.js version, and BaileyOS version
- Relevant log output (sanitize any sensitive information like IP addresses or credentials)

## Suggesting Features

Open a GitHub issue with the "feature request" label. Describe:

- What you want to accomplish
- Why the current functionality does not meet your needs
- How you envision the feature working

## Documentation

Documentation improvements are always welcome. If you find something unclear, incomplete, or incorrect in the docs, submit a PR with the fix.

## Code of Conduct

All contributors are expected to follow the [Code of Conduct](CODE_OF_CONDUCT.md). Be respectful, constructive, and welcoming.

## Security Issues

Do **not** open a public issue for security vulnerabilities. See [SECURITY.md](SECURITY.md) for responsible disclosure instructions.

## License

By contributing to BaileyOS, you agree that your contributions will be licensed under the [Apache License 2.0](LICENSE).
