# Throne Display

Firmware for a small round desk display that shows an Emperor Claw company in real time: your agents as pixel-art characters working at desks around the Emperor's throne, how healthy they are, and what the team is saying.

It reads the read-only `GET /api/mcp/live` endpoint. It never writes anything to the server.

## Set up from the browser (recommended)

You need Chrome or Edge on a computer (they support Web Serial; Safari, Firefox and phones do not) and an Emperor Claw admin account.

1. Plug the display into the computer with a USB-C data cable.
2. In Emperor Claw, open **Settings → Displays** and click **Connect display**. Pick the display in the browser's list (it shows up as a USB JTAG/serial device, vendor `303A`).
3. **Firmware**: the page asks the display for its version. If it already runs the version this server ships, click **Skip — already installed**; otherwise click **Install firmware**. The page downloads the four images, checks their SHA-256 and writes them with [esptool-js](https://github.com/espressif/esptool-js). Saved settings survive (NVS is not erased). It takes about a minute.
4. **Wi-Fi**: the display scans and the page lists what it found, strongest first. Pick your network and type its password. Only 2.4 GHz networks appear, because the ESP32-C3 has no 5 GHz radio. Use **Other network** for a hidden SSID.
5. **Options**: name the display (default "Desk display") and choose whether to **Include my private chats** (see [Private chats](#private-chats)).
6. **Finish**: the page creates a Read only token for this display itself (you never see or copy it), sends Wi-Fi, server URL (the page's own address) and token to the board in one `provision` command, and waits. The board restarts, joins Wi-Fi and fetches the feed. The page reports **Your display is live**, or the exact problem: wrong Wi-Fi password, network not found, Wi-Fi timeout, or token rejected, with **Try again**.

The page treats either signal as success: the board printing a `200` over USB, or the server seeing the new token's first use. So it still confirms success when the USB link drops while the display restarts. A token whose display never went live (failure, timeout, **Change Wi-Fi settings**, or leaving the page) is revoked, best effort, and the next attempt mints a new one. The page refuses to provision when it is itself served over plain `http://` from a public host (see TLS below). Each display's token is listed on the same tab (name, created, last used, private chats on or off) with **Revoke**.

The manual routes below (captive portal, serial console) still work and are the fallback when you have no Chrome or Edge at hand.

### Publishing the firmware for the browser installer

The app serves the images from `public/firmware/throne-display/` (public, no login, no secrets). After changing the firmware:

```sh
PIO_BIN=/path/to/pio npm run firmware:build    # pio run + copy the images + write manifest.json
```

The version is defined once, as `custom_fw_version` in `platformio.ini`. It is compiled in as `FW_VERSION` (printed at boot and by `version`) and copied into `manifest.json` with each image's offset, size and SHA-256:

| Image | Offset |
|---|---|
| `bootloader.bin` | `0x0` |
| `partitions.bin` | `0x8000` |
| `boot_app0.bin` | `0xe000` (from the Arduino framework package) |
| `firmware.bin` | `0x10000` |

`npm run test:unit` fails if the published images do not match their manifest or the manifest version does not match `platformio.ini`. Bump `custom_fw_version` on every firmware change you ship, or the installer will offer **Skip** to boards that run older code.

## Hardware

**ESP32-2424S012C-I** ("1.28 inch round CYD"):

| Part | Details |
|---|---|
| MCU | ESP32-C3, RISC-V single core at 160 MHz, no FPU, about 400 KB SRAM, no PSRAM, 4 MB flash |
| Display | 1.28" round IPS, 240x240, GC9A01 over SPI |
| Touch | CST816D capacitive, I2C address `0x15` (chip id `0xB6`) |
| USB | USB-C, native USB-Serial/JTAG (no UART bridge) |
| Power | USB or a 3.7 V LiPo (IP5306 charger on board) |

### Pin map

Source: [espboards.dev: CYD ESP32-2424S012](https://www.espboards.dev/esp32/cyd-esp32-2424s012/), also checked on the device (the touch controller answers at `0x15`).

| Signal | GPIO |
|---|---|
| LCD SCLK | 6 |
| LCD MOSI | 7 |
| LCD CS | 10 |
| LCD DC | 2 |
| LCD RST | not wired to a GPIO (tied to EN) |
| LCD backlight | 3 (PWM) |
| Touch SDA / SCL | 4 / 5 |
| Touch INT / RST | 0 / 1 |
| BOOT button | 9 |

All pins are in `src/display_config.h`. If the touch coordinates come out mirrored on your board revision, add `-DTOUCH_INVERT_X=1`, `-DTOUCH_INVERT_Y=1` or `-DTOUCH_SWAP_XY=1` to `build_flags`.

## Build and flash

You need [PlatformIO Core](https://platformio.org/install/cli).

```sh
cd devices/throne-display
pio run                                   # build
pio run -t upload --upload-port COM6      # flash (use your port, e.g. /dev/ttyACM0)
pio device monitor -p COM6 -b 115200      # serial log
```

If the upload can't find the board, hold **BOOT**, tap **RST**, release BOOT, and run the upload again.

Flashing (from PlatformIO, esptool or the browser) only writes the four images, so the Wi-Fi and token saved in NVS survive. Only `reset` (or **Erase settings** in the portal) clears them.

### USB and Wi-Fi power

Wi-Fi transmit bursts draw current spikes. On this board, at the ESP32-C3's default ~20 dBm, they could brown out the USB-Serial/JTAG link: the screen kept running, but the computer lost the COM port a few seconds after Wi-Fi started (demo mode, with the radio off, stayed connected for as long as we watched). The firmware therefore:

- starts Wi-Fi 3 s after boot (`WIFI_START_DELAY_MS`), after USB enumeration and display init;
- caps transmit power at 15 dBm (`WIFI_TX_POWER`, override with `-DWIFI_TX_POWER=WIFI_POWER_11dBm` or similar in `build_flags`) for station, scan and portal;
- keeps the default modem sleep, which lowers the average draw between polls.

If the port still drops, use a shorter or better cable, plug into a port on the computer itself rather than a hub, or lower `WIFI_TX_POWER`. A drop does not affect the display itself; it only matters while a computer is talking to it.

## First boot: demo mode

When the display has no configuration, it starts in **demo mode**. A simulated company of 7 agents changes state, finishes tasks, raises flags, goes down and comes back, and chats. Every visual shows up within a minute, so you can check the hardware before any server is set up. A small **DEMO** tag appears at the bottom.

## Setup without a browser: captive portal

Use this when you can't use [the browser installer](#set-up-from-the-browser-recommended).

1. In Emperor Claw, open **Settings → Access Tokens** and create a token with the **Read only** scope. Tick **Include my private chats** if you want the display to show your own direct conversations with each agent (see [Private chats](#private-chats)). Copy the token.
2. On the display, **press and hold for 5 seconds**. A ring fills around the edge, then the SETUP screen appears.
3. On your phone or laptop, join the Wi-Fi network **`EmperorClaw-Display`** with the password shown on the display (12 random characters like `k7mp-x3qa-9fhd`, dashes included). The password is random and new every time setup opens, and it only appears on the screen (never in the serial log), so only someone who can see the display can reach the setup page. A setup page should open. If it doesn't, browse to `http://192.168.4.1`.
4. Pick your Wi-Fi network from the list (the display's own scan, strongest first; use **Other network** for a hidden SSID), enter its password, your Emperor Claw URL (for example `https://emperor.example.com`) and the token. Tap **Save and connect**.
5. The display restarts and connects. The status dot at about the 1:30 position turns green when live data arrives.

**2.4 GHz only.** The ESP32-C3 cannot see or join 5 GHz networks. A 5 GHz-only SSID typed by hand fails silently (the display stays on "Joining Wi-Fi" and logs `[net] wifi_fail no_network`), which is why both setup routes pick from the display's own scan. If your router uses separate names per band, choose the 2.4 GHz one; a single name for both bands works.

Settings are stored in the chip's NVS (Preferences). Saved secrets are never shown again on the setup page and never printed to the serial log. Leave the password or token field blank to keep the saved value. Changing the server URL without pasting a new token erases the saved token and asks for one, so a token is only ever sent to the server it was entered for (the serial `server` command does the same). The setup page also has **Run demo mode** and **Erase settings** buttons. Setup gives up after 10 minutes, and tapping the screen cancels it.

### Serial console (115200 baud)

| Command | Effect |
|---|---|
| `help` | List commands |
| `version` | Prints `[version] <FW_VERSION>` (also printed at boot as `[boot] firmware <FW_VERSION>`) |
| `scan` | Scans for Wi-Fi (see below) |
| `provision <base64>` | Sets Wi-Fi, server and token in one step (see below) |
| `status` | Boot summary, network state, heap |
| `stats` | FPS, render and push time, heap (also logged every 30 s) |
| `demo` / `live` | Switch data source (saved) |
| `setup` | Open the setup portal |
| `ssid <v>`, `pass <v>`, `server <url>`, `token <v>`, then `save` | Configure without the portal |
| `mode <0-3>` | Jump to a mode |
| `touch` | Toggle touch debug logging |
| `reset` | Erase all settings and restart |

The browser installer drives the console with these machine-readable lines (each starts with a fixed tag; secrets are never echoed):

| Command | Replies |
|---|---|
| `version` | `[version] 1.1.0`. Firmware older than 1.1.0 answers `[cmd] unknown 'version'`. |
| `scan` | `[scan] start`, then one `[scan] {"ssid":"Home","rssi":-58,"secure":true,"ch":6}` per network (strongest first, one per SSID, up to 20, hidden SSIDs skipped), then `[scan] done <n>`. Or `[scan] error <busy\|failed\|timeout\|portal_active>`. Asynchronous: the screen keeps animating. |
| `provision <base64>` | Base64 of UTF-8 JSON `{"v":1,"ssid":"…","pass":"…","server":"https://…","token":"…"}`. All four are validated first (SSID 1 to 32 bytes, password empty or 8 to 64, server `http(s)://` up to 127, token up to 199), then saved together, live mode is switched on and the board restarts: `[prov] ok ssid='…' server='…'`, `[prov] restarting`. On a bad value nothing is saved: `[prov] error <empty\|base64\|json\|version\|ssid\|pass\|server\|insecure_server\|token>`. The decoded payload and the JSON document's memory are wiped on every path. |

After a restart, the network task reports `[net] connecting to Wi-Fi '…'`, then `[net] Wi-Fi connected, IP … RSSI …` or `[net] wifi_fail <wrong_password|no_network|timeout> reason=<wifi reason code>`, then `[net] 200 in …` per successful fetch or `[net] fetch failed code=<n> …` (401/403: token rejected).

The line buffer is 768 bytes and is wiped after every command, because a line can carry a password or token.

## Modes and gestures

Swipe **left / right** to change mode. Dots along the bottom edge show which mode is active.

| Mode | What you see |
|---|---|
| **Throne Room** (default) | A round room seen from above. The Emperor sits on a throne in the middle. Agents sit at desks around it. **Working**: monitor glows and flickers and code sparks rise. **Typing**: animated "..." bubble. **Idle**: leaves the desk and wanders, gently bumping into others. **Attention**: red "!" bobbing above the head. **Down / offline**: translucent grey ghost floating by the desk. When an agent's task finishes or disappears, confetti bursts. A gold **envelope** next to an agent's head means a private message in the last 10 minutes. **Tap an agent** to open it in Focus. |
| **Focus** | One agent per page. **Swipe up / down** to move between agents. Shows a large character, the name curved along the top, a state chip, the current activity (scrolls if it is long), the task title, and when the agent was last seen. The outer ring is the health color, and its progress arc tracks how long the agent has been in its current state (one turn per minute). A gold envelope beside the character means a private message in the last 10 minutes. **Tap** to open the agent's private chat. |
| **Focus: private chat** | Your direct messages with that agent, as bubbles inside the circle: yours on the right in gold, the agent's on the left in its own color, newest at the bottom, each with its age. A padlock in the header marks it as private. "No private messages" when there are none (or the token does not include private chats). **Swipe down** for older messages, **swipe up** for newer ones. **Tap**, or swipe left / right, to go back to the agent page. |
| **Pulse** | A health radar. Each agent gets one arc segment around the edge, colored by health, and lights up as the rotating sweep passes over it. The center shows healthy/total, plus working, in progress, overdue and pending approvals. Tap a segment to focus that agent. |
| **Feed** | The latest messages as chat bubbles, each with the sender's mini character. New messages slide in from the bottom. |

Gesture map:

| Where | Gesture | Action |
|---|---|---|
| Any mode | Swipe left / right | Next / previous mode (in the private chat: close the chat) |
| Throne Room | Tap an agent | Focus that agent |
| Pulse | Tap a segment | Focus that agent |
| Focus | Swipe up / down | Next / previous agent |
| Focus | Tap | Open the agent's private chat |
| Private chat | Swipe down / up | Older / newer messages |
| Private chat | Tap | Back to the agent page |

To get from Focus back to the Throne Room, swipe right. (Earlier firmware used a tap for this; the tap now opens the private chat.)

Long press anywhere:

- **Hold 1.5 to 5 s, then release**: switch between demo and live. This only works once the display is configured.
- **Hold 5 s**: open the setup portal.

Overlays that appear in every mode:

- **Red pulsing rim**: at least one agent is down.
- **Gold pulsing ring**: there are pending approvals.
- **Status dot**: violet means demo, green means live, gold means connecting or stale data, red means error. It brightens during a fetch.
- **Backlight**: dims after 2 minutes with no touch and no data change. It wakes on touch or when new data arrives.

Agent colors are health-coded in rings and segments: green healthy, orange attention, red down, blue idle. Each character's body color comes from the agent's `hue`.

## Data contract

`GET {server}/api/mcp/live?messages=8` with `Authorization: Bearer <token>`. The firmware polls every **4 s** and sends `If-None-Match` with the last `ETag`, so an unchanged response costs only a `304`. On errors it backs off exponentially, up to 60 s; a `401` or `403` waits 60 s straight away.

The fields it uses:

- `company.name`
- `summary.{agents, healthy, attention, down, idle, working, pendingApprovals, tasksInProgress, tasksOverdue}`
- `agents[].{id, name, short, hue, health, state, activity, task.{id,title}, lastSeenSec, unanswered}`
- `messages[].{id, from, agentId, text, ageSec}`
- `dm[].{agentId, messages[].{me, text, ageSec}}` (optional: a server without `dm` is treated as "no private messages")

Assumptions the firmware makes about the server:

- `health` is one of `healthy | attention | down | idle` and `state` is one of `typing | working | idle | offline`. Unknown values are treated as idle.
- Messages are sorted on the device by `ageSec`, oldest to newest, so the server may return them in either order.
- A task "completes" (confetti) when an agent's `task.id` changes or `task` becomes `null`.
- Up to 24 agents and 12 messages are kept, plus up to 4 private messages per agent and 40 in total (one shared pool, the server's own caps). Any extra are ignored.
- Text is converted to ASCII, because the bitmap fonts are ASCII-only: smart quotes and dashes are mapped, accented Latin letters fold to their base letter (á→a, ñ→n, č→c, ľ→l, ô→o, ß→ss, and so on, upper and lower case), and emoji are dropped.
- Every clock (`ageSec` in `messages` and `dm`, `lastSeenSec`) is aged on the device from the time of the last `200`. The server's `ETag` ignores those fields, so a `304` keeps the cached snapshot and the times keep moving.
- Chunked and `Content-Length` responses both work. The connection is kept alive between polls, so TLS handshakes are rare.

## Private chats

A Read only token created with **Include my private chats** adds a `dm` section to the feed: the token creator's own exchanges with each agent (messages they wrote, and the agent's replies to them). Agent chats are shared by the company, so other people's messages in the same chat are never sent. The server stops sending `dm` as soon as the creator is removed from the company.

**Privacy:** anyone who can see the display can read these messages. Only enable it on a display you control, and revoke the token if the display leaves your desk. Without the option, the display never shows private chats; activity in a private chat only appears as "Working in a private chat".

**TLS:** the server certificate is always verified (chain and hostname). By default the firmware uses the Mozilla CA bundle that ESP-IDF compiles into the Arduino core's mbedTLS library (`x509_crt_bundle`, 136 roots, about 64 KB of flash), so any server with a certificate from a public CA (Let's Encrypt, ZeroSSL, Cloudflare, ...) works without configuration. A failed handshake logs `[net] tls error <code>: <reason>`.

**Plain http://** is only accepted for private-network hosts (`10.x`, `172.16-31.x`, `192.168.x`, `*.local`), for LAN setups without a certificate. Any other `http://` server is refused by the portal, the serial `server` command and `provision` (`[prov] error insecure_server`), and an already-saved one is never contacted: the board logs `[net] error insecure_server` and the screen says "use an https:// URL". The browser installer applies the same rule to its own address.

**Your own CA:** to trust only a private CA instead of the bundle, create `src/root_ca.h` containing `#define EMPEROR_ROOT_CA "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n"`. It is picked up automatically.

## Memory and rendering design

The ESP32-C3 has no PSRAM, and Wi-Fi plus TLS need roughly 50 KB of heap. These decisions follow from that:

- **8-bit indexed frame buffer.** A full 16-bit frame would be 115 KB, so the firmware renders into a single 240x240 `LGFX_Sprite` at `palette_8bit` (57.6 KB) and pushes it to the panel every frame. LovyanGFX expands the palette to RGB565 on the fly.
- **Allocated first.** The frame buffer is allocated before Wi-Fi starts, while the heap is still one contiguous block.
- **Palette of 16 ramps x 16 levels.** Index = `ramp << 4 | level`. Ramp 0 is a cool neutral; ramps 1 to 15 are hues spaced 24° apart. Because every ramp runs dark to bright, glows are just "keep the brighter level" writes, with no blending math. Mode transitions fade by scaling the palette, not the pixels.
- **Integer math only.** A 1024-step sine table in Q14, integer square roots, and fixed-point easing. The C3 has no FPU.
- **Background networking.** Fetching, parsing and the demo simulation run on their own FreeRTOS task. Each finished snapshot is copied under a mutex into a shared slot. The render loop copies it into its own fixed-size `Model`, so drawing never waits on I/O and never allocates.
- **Bounded JSON parsing.** ArduinoJson parses straight from the socket with a filter document, so only the needed fields are kept.
- **Deterministic characters.** Each agent's 12x12 character is generated from the FNV-1a hash of its `id`. The left half is random, mirrored, auto-shaded and outlined, with two animation frames. The same id always gives the same character.

Measured on the device (demo mode, 7 agents):

| Measurement | Value |
|---|---|
| Free heap at boot | 223 KB |
| Free heap after the frame buffer | 165 KB (largest block 139 KB) |
| Free heap, steady state in demo | about 152 KB (largest block 131 KB) |
| Free heap, live mode with Wi-Fi up (before TLS) | about 107 KB (largest block 86 KB) |
| Frame rate | about 30 fps (capped at 30) in every mode |
| Push time | about 14.7 ms per frame |
| Render time | Throne Room 8 to 17 ms, Focus about 16 ms, Pulse about 10 ms, Feed about 7 ms |
| Static RAM | 30.5% (100 KB; the private-chat pool adds about 4.5 KB per model copy, three copies) |
| Flash | 38% of the 3 MB app partition (`huge_app.csv`, no OTA; firmware 1.1.0) |

Every `[net] 200` line reports the heap of that fetch: `heap` (free after the fetch, TLS session still open for keep-alive), `json` (heap held by the parsed, filtered document), `low` (free while the document and TLS session were both alive, the fetch's low point) and `min` (lowest free heap since boot). A live company with private chats was seen at about 46 KB `heap`; `json` shows how much of the gap is the document (bounded by the filter and the server's caps: 24 agents, 8 messages, 40 private messages) rather than TLS.

## Source layout

```
src/
  main.cpp            boot, frame loop, overlays, gestures, serial console
  display_config.h    LovyanGFX device (GC9A01 + PWM backlight) and pin map
  palette.*           256-color ramp palette and fades
  ui_common.*         frame buffer primitives, arcs, glows, arc text, easing, particles
  sprites.*           procedural characters, throne and crown pixel art
  data_model.*        fixed-size model, mutex publish/take, hashing, ASCII sanitizing
  live_client.*       network task: Wi-Fi, HTTP(S), ETag, chunked body reader, JSON mapping
  demo_data.*         simulated company
  config_portal.*     NVS config and captive setup portal
  serial_setup.*      machine-readable setup commands: scan, provision
  version.h           FW_VERSION (from custom_fw_version in platformio.ini)
  touch.*             CST816D driver and gesture recognizer
  app.*               UI state, per-agent animation, layout helpers
  modes/              throne.cpp, focus.cpp, pulse.cpp, feed.cpp
```
