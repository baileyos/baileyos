# Supported Devices

BaileyOS uses a plugin architecture. Each device integration is a self-contained plugin that handles communication with the hardware over its native protocol. Below is the full list of plugins included in the Community edition.

## Device Plugins

| Plugin | Category | Protocol | Description |
|--------|----------|----------|-------------|
| annke-cameras | Cameras | RTSP / ONVIF | Annke IP camera integration. Supports live RTSP streams, motion detection events, and ONVIF device discovery. |
| apple-tv | AV | AirPlay / DACP | Apple TV remote control. Play, pause, navigate menus, and read current playback status. |
| audio-bridge | Audio | Virtual | Software audio routing bridge. Routes audio streams between zones and sources without dedicated hardware. |
| av-devices | AV | IR / RS-232 | Controls AV receivers, amplifiers, and other equipment via infrared or RS-232 serial commands. Supports learning custom IR codes. |
| broadlink | Control | RF / IR | Broadlink RM series integration. Sends and learns RF (433 MHz) and IR commands for controlling devices that lack native smart home support. |
| centralite-elegance | Lighting | Serial (LiteJet) | Centralite Elegance lighting control via the LiteJet serial protocol. Supports on/off, dimming, and scene recall for up to 128 lighting loads. |
| device-registry | System | Internal | Central device registration and discovery service. All other plugins register their devices through this plugin. Not a hardware integration. |
| elk-m1 | Security | TCP | ELK M1 security panel integration. Reads zone status (open, closed, violated, bypassed), arms and disarms partitions, reads temperature sensors, and controls outputs. Connects via M1XEP Ethernet interface. |
| esphome-satellite | Voice / Sensors | HTTP / mDNS | ESPHome voice satellite bridge. Connects to ESPHome devices running the voice assistant firmware. Also reads sensor data (temperature, humidity, motion) from ESPHome nodes. |
| htd-lync12 | Audio | TCP (GW-SL1) | HTD Lync 12-zone whole-home audio system. Controls volume, source selection, bass, treble, and balance for up to 12 independent audio zones. Connects via the GW-SL1 IP gateway. |
| lg-tv | AV | WebSocket | LG webOS smart TV control. Power on/off, input switching, volume, app launching, and screen status via the WebSocket API. |
| mitsubishi-projector | AV | RS-232 / TCP | Mitsubishi projector control via serial or network. Power, input selection, picture mode, and lamp hour monitoring. |
| rainbird | Irrigation | HTTP | Rain Bird irrigation controller integration. Start and stop zones, read rain sensor status, and manage watering schedules. |
| ratgdo | Garage | MQTT | ratgdo garage door opener integration (ESPHome-based). Open, close, and monitor garage door state. Supports obstruction detection and light control. |
| reolink-cameras | Cameras | HTTP / RTSP | Reolink IP camera integration. Live RTSP streams, motion and person detection events, PTZ control (on supported models), and snapshot capture. |
| shelly-gate | Gate | HTTP / MQTT | Shelly relay-based gate controller. Open, close, and read gate status using Shelly relay devices wired to gate motors. |
| ttlock | Locks | Cloud API | TTLock smart lock control. Lock, unlock, and read lock status. Requires TTLock cloud API credentials (the lock itself communicates via Bluetooth through a TTLock gateway). |
| xmeye-cameras | Cameras | XMEye Protocol | XMEye DVR and camera integration. Connects to XMEye-compatible DVR systems for live viewing and playback. |

## Adding New Devices

BaileyOS is designed to be extended. If your device is not listed above, you can write a plugin for it. See [creating-a-plugin.md](creating-a-plugin.md) for a step-by-step guide.

Community-contributed plugins are welcome. See the [Contributing Guide](../CONTRIBUTING.md) for how to submit a plugin via pull request.
