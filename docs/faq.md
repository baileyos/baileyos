# Frequently Asked Questions

## How is this different from Home Assistant?

Home Assistant is an excellent project and we respect the work that community has done. BaileyOS takes a different approach in a few key areas:

- **Plugin isolation.** Each device integration in BaileyOS is a fully isolated plugin. If one plugin crashes or misbehaves, the rest of the system keeps running. There is no shared integration runtime where one bad device can take down your whole setup.

- **No YAML.** BaileyOS configuration is done through the web UI or simple JSON files. There is no domain-specific configuration language to learn.

- **Upgrade path to AI.** BaileyOS Pro (paid) adds facial recognition, voice identification, and a local LLM -- capabilities that run on your hardware with no cloud dependency. This is not bolted on after the fact; the plugin architecture was designed from the start to support these workloads.

- **Simpler by design.** BaileyOS focuses on doing one thing well: giving you a single dashboard to control every device in your house. It is not trying to be an operating system or an automation scripting platform. If you want deep automation, the paid Automation tier adds rules and scenes in a structured way.

That said, if Home Assistant works for you, keep using it. BaileyOS is an alternative, not a replacement.

## What is the catch?

There is no catch. The Community edition is genuinely free and open source under the Apache 2.0 license. You get the full dashboard, all 18 device plugins, real-time status, and web-based control at no cost.

We make money from two optional paid tiers:

1. **Automation** -- adds rules, scenes, and schedules
2. **Intelligence** -- adds facial recognition, voice ID, and a local LLM

The open source platform is not feature-limited, time-limited, or nag-ware. It is a complete product. The paid tiers add capabilities that require additional engineering and support.

## Why Windows?

BaileyOS runs on Windows, Linux, and macOS. Windows was the first deployment environment because the original installation was on a Windows machine. The codebase is Node.js and TypeScript with no platform-specific dependencies. It runs the same on all three operating systems.

If you are running on a Raspberry Pi, you will use Linux. If you have an old Mac mini, macOS works fine. If you have a Windows PC in a closet, that works too.

## Is my data safe?

Yes. BaileyOS is designed to be fully local.

- **No cloud.** The platform runs entirely on your local network. It does not connect to any external servers, cloud services, or APIs (with one exception: the TTLock plugin uses the TTLock cloud API because that is the only way TTLock hardware communicates).
- **No telemetry.** There is no usage tracking, analytics, crash reporting, or phone-home behavior of any kind.
- **No accounts.** You do not need to create an account, sign in, or provide an email address to use BaileyOS.
- **Verify it yourself.** The source code is open. You can read every line, audit the network traffic, and confirm that nothing leaves your network.

Your camera feeds, lock codes, security panel status, and device data stay on your hardware. Period.

## Can I contribute device drivers?

Yes. BaileyOS is built on a plugin architecture specifically to make it easy to add new device support.

To write a new device plugin:

1. Read [creating-a-plugin.md](creating-a-plugin.md) for the plugin structure and API
2. Fork the repository and create a branch
3. Build and test your plugin
4. Submit a pull request following the [Contributing Guide](../CONTRIBUTING.md)

We are especially interested in plugins for:

- Z-Wave and Zigbee devices (via USB coordinators)
- Lutron Caseta and RadioRA
- Sonos speakers
- Ecobee and Nest thermostats
- Ring and Unifi cameras

If you have hardware and want to write a plugin, open an issue to discuss the approach before starting work.

## What Node.js version do I need?

Node.js 18 or later. We recommend the latest LTS release.

## Can I run BaileyOS in Docker?

A Docker image is planned but not yet available. For now, clone the repository and run with `npm install && npm run dev`. If you would like to help build the Docker image, see the [Contributing Guide](../CONTRIBUTING.md).

## How do I get help?

- Open an issue on GitHub for bugs or feature requests
- Check the docs/ folder for guides and reference material
- For security issues, see [SECURITY.md](../SECURITY.md)
