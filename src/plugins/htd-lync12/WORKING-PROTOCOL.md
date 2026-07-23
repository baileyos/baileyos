# HTD Lync 12 — Confirmed Working Protocol (Bailey → GW-SL1)

**Status: CONFIRMED on-site with the user 2026-06-04.** This is the authoritative reference.
All earlier notes about "volume corrupts the gateway / it's a hardware fault / Fixed Volume mode"
are **obsolete** — the real issue was a one-byte command-format bug (see "The one gotcha").

Gateway: HTD **GW-SL1** IP gateway at `192.168.1.11:10006` (TCP). Zones 1–12.
Frame = `02 <b1> <zone> <cmd> <data> <cksum>`, where **`cksum = (sum of the 5 preceding bytes) & 0xFF`**.

## ✅ Confirmed working from the Bailey dashboard
| Action            | Frame (zone 1 example)      | Notes |
|-------------------|-----------------------------|-------|
| Power ON          | `02 00 01 04 57 5E`         | byte[1]=00; off = `58` |
| Power OFF         | `02 00 01 04 58 5F`         | |
| Mute ON           | `02 00 01 04 1E 25`         | off = `1F` |
| Input 1 select    | `02 00 01 04 10 17`         | In *n* = `0x10 + (n-1)` for 1–12; `0x63 + (n-13)` for 13–18 |
| Input 2 select    | `02 00 01 04 11 18`         | |
| **Volume set**    | `02 01 01 15 <data> <cksum>`| **byte[1]=01** ⚠️ ; `data = (196 + v) & 0xFF`, v = 0–60 |
| Query all zones   | `02 00 00 05 00 07`         | returns all 12 zones in one ~182-byte response |

- **Volume example:** v=20 → data `0xD8` → `02 01 01 15 D8 F1` (matches "Zone 1 Volume Level -20" in the codes doc).
- **Volume display:** the readback raw byte `frame[9]` = `196 + v`; show `(raw - 196) & 0xFF` (clamp >60 → 0).
- Source of truth for the byte values: `Lync RS232 Codes Full.pdf` / `lync_hex_codes.pdf` (in Downloads). Every checksum in those docs matches the formula above.

## ⚠️ The one gotcha (do not regress)
The **volume** frame uses **`byte[1] = 0x01`**. *Every other command* uses `byte[1] = 0x00`.
Sending a volume frame with `byte[1] = 0x00` (`02 00 z 15 …`) is **malformed** and scrambles the
gateway's volume registers for **all** clients (the HTD app then shows negative/garbage volume and
can't control volume either). **Recovery: power-cycle the HTD zone controller.** Never set byte[1]=0
on a 0x15 frame.

## Behavior notes
- The gateway does **not** reliably echo status after a command, so the driver updates local state
  optimistically (so the UI value is immediate and correct).
- A command succeeds at the **controller** even if the **zone amplifiers** are powered off — in that
  case there's simply no sound. (Amps are a separate power switch.)
- The HTD app is reliable and **multi-client** (multiple phones stay in sync) — running it alongside
  Bailey is fine.

## Not yet confirmed
- **Bass / treble** — still on the increment (up/down toggle) method (`0x26/0x27` bass, `0x28/0x29`
  treble, byte[1]=00) and the bass/treble *readback* misparses (constant `-14`), so the step count is
  wrong. The codes docs list volume but **no** absolute bass/treble, so it's likely toggle-only; the
  fix is to drive the toggles without relying on the bad readback (e.g. floor-then-step-up). Parked.
- Per-zone **source readback** (`frame[8]`) reads a constant `~13` — a byte-offset misparse; the
  guided-audio flow tracks routes in software (`pickInput`) to work around it.
