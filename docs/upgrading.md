# Upgrading to Paid Tiers

BaileyOS Community is a complete, fully functional smart home platform. The paid tiers add capabilities on top of what Community already provides. Nothing is taken away from the free version -- the paid tiers are purely additive.

## Automation Tier

The Automation tier adds structured rules, scenes, and schedules to BaileyOS.

**What it adds:**

- **Rules engine** -- define if/then rules that trigger actions based on device states. Example: "If the ELK M1 reports zone 3 violated after 10 PM, turn on the front porch lights and send a notification."
- **Scenes** -- save and recall multi-device states with one tap. Example: a "Movie Night" scene that dims the living room lights to 20%, powers on the projector, switches the AV receiver to HDMI 2, and sets audio zone 1 to volume 35.
- **Schedules** -- time-based triggers that run actions on a recurring basis. Example: run the irrigation system every morning at 6 AM for 15 minutes, but skip if the rain sensor is active.
- **Conditional logic** -- chain conditions together with AND/OR logic, add delays, and create sequences.
- **Notification actions** -- send alerts via webhook, email, or local push when a rule fires.

**Hardware requirements:** Same as Community. No GPU or additional hardware needed. 4 GB RAM recommended if you have many active rules.

**How to install:**

1. Obtain the Automation plugin package from [baileyos.com](https://baileyos.com)
2. Extract the plugin folder into your BaileyOS `plugins/` directory
3. Restart BaileyOS
4. The Automation section will appear in your dashboard

## Intelligence Tier

The Intelligence tier adds AI-powered capabilities that run locally on your hardware.

**What it adds:**

- **Facial recognition** -- identifies known household members via your existing cameras using FaceNet. Enroll faces through the dashboard. When a recognized person is detected, the system can trigger personalized automations (requires Automation tier).
- **Presence detection** -- combines camera feeds, WiFi device tracking, and BLE beacon data to determine which rooms are occupied and by whom.
- **Voice identification** -- distinguishes household members by voice. When someone speaks a command, the system knows who is speaking and can apply per-person preferences and permissions.
- **Local LLM** -- a large language model running on your GPU that powers natural language device control. Talk to your house in plain English. The LLM interprets your intent and maps it to device actions. No internet connection required.
- **Activity patterns** -- learns your household routines over time and offers suggestions. Does not act autonomously unless you enable it.

**Hardware requirements:** Dedicated NVIDIA GPU (RTX 4070 Ti or better), 32 GB RAM, 50 GB free disk space. See [hardware-requirements.md](hardware-requirements.md) for details.

**How to install:**

1. Obtain the Intelligence plugin package from [baileyos.com](https://baileyos.com)
2. Verify your hardware meets the requirements (GPU, RAM, disk space)
3. Install the NVIDIA CUDA toolkit if not already present
4. Extract the plugin folder into your BaileyOS `plugins/` directory
5. Run the model download script: `npm run download-models`
6. Restart BaileyOS
7. The Intelligence section will appear in your dashboard, along with a model status page

## Pricing

Visit [baileyos.com](https://baileyos.com) for current pricing.

## Can I try before I buy?

The Community edition is free and fully functional. Install it, connect your devices, and use it as long as you want. When you decide you want automation rules or AI capabilities, the paid tiers drop in as plugins with no migration or data conversion required.

## Do paid tiers require a subscription?

Visit [baileyos.com](https://baileyos.com) for the current pricing model.

## Do paid tiers phone home?

No. The paid plugins run entirely on your local hardware, the same as the Community plugins. There is no license server, no cloud validation, and no telemetry. Once installed, they work offline indefinitely.
