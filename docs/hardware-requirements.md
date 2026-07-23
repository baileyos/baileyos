# Hardware Requirements

BaileyOS is designed to run on minimal hardware. The Community edition (free, open source) needs nothing more than an old laptop or a Raspberry Pi.

## Tier 1: Community (Free, Open Source)

The open source platform with full device control and dashboard.

- **CPU:** Any dual-core processor (x64 or ARM64)
- **RAM:** 2 GB minimum, 4 GB recommended
- **GPU:** Not required
- **Storage:** 1 GB free disk space
- **OS:** Windows, Linux, or macOS
- **Network:** Ethernet recommended for reliability, WiFi works fine

**Example hardware:**

- Raspberry Pi 4 (4 GB) -- approximately USD 55
- Any laptop manufactured after 2012
- Used Dell OptiPlex or HP ProDesk mini PC -- USD 50-100 on eBay
- Intel NUC or equivalent -- USD 100-150

This tier gives you the full dashboard, all 18 device plugins, real-time status, and web-based control. No GPU, no beefy CPU, no special hardware.

## Tier 2: Automation (Paid Add-On)

Adds automation rules, scenes, schedules, and conditional triggers to the Community platform.

- **CPU:** Quad-core recommended
- **RAM:** 4-8 GB recommended
- **GPU:** Not required
- **Storage:** 2 GB free disk space
- **OS:** Windows, Linux, or macOS

The automation engine runs rule evaluations and scene triggers. It adds modest CPU and memory overhead but does not require a GPU. The same Raspberry Pi or mini PC that runs the Community tier will handle automation rules without issue, though 4 GB RAM is recommended if you have many rules.

## Tier 3: Intelligence (Paid, Full BaileyOS Pro)

Adds facial recognition, voice identification, presence detection, and local LLM capabilities.

- **CPU:** 6-core or better (Intel i5/i7/Xeon, AMD Ryzen 5/7)
- **RAM:** 32 GB recommended (16 GB minimum)
- **GPU:** Dedicated GPU required -- NVIDIA RTX 4070 Ti or better
- **Storage:** 50 GB free (for AI models)
- **OS:** Windows or Linux (macOS supported but no CUDA acceleration)

**Why a GPU?**

The Intelligence tier runs computer vision models (YOLO for object detection, FaceNet for facial recognition) and a local large language model. These workloads require GPU acceleration to run in real time. An RTX 4070 Ti provides enough VRAM (12 GB) to run all vision models plus a 7B-parameter LLM simultaneously.

**Example hardware:**

- Custom build with RTX 4070 Ti, 32 GB RAM -- USD 1,600-2,000
- Used workstation with compatible GPU -- USD 800-1,200
- Any existing PC with a compatible NVIDIA GPU

**Note:** The Intelligence tier runs entirely on your local hardware. There is no cloud processing, no API calls to external services, and no data leaving your network. The GPU stays in your house.

## Summary

| Tier | Price | CPU | RAM | GPU | Use Case |
|------|-------|-----|-----|-----|----------|
| Community | Free | Dual-core | 2-4 GB | None | Dashboard and device control |
| Automation | Paid add-on | Quad-core | 4-8 GB | None | Rules, scenes, schedules |
| Intelligence | Paid | 6-core+ | 32 GB | RTX 4070+ | Vision AI, voice ID, local LLM |
