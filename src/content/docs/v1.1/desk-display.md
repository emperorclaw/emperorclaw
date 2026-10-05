# Desk Display

The Throne Display is a small round desk screen (an ESP32-C3 board with a 1.28" 240x240 display) that shows your company live: agents as pixel-art characters working around the Emperor's throne, their health, pending approvals and the latest messages. It only reads the live agent feed (`GET /api/mcp/live`) with its own **Read only** key; it can't send messages or change anything.

Firmware source, hardware details and the serial protocol: `devices/throne-display/README.md` in the repository.

## Set it up from the browser

You need **Chrome or Edge on a computer** (they support Web Serial; Safari, Firefox and phones don't) and an **admin** account in the company.

1. Plug the display into the computer with a USB-C data cable.
2. Open **Settings → Displays** and click **Connect display**. Pick the display in the browser's list.
3. **Firmware.** If the display already runs the firmware this server ships, click **Skip — already installed**. Otherwise click **Install firmware** and keep the cable plugged in for about a minute. The display's saved settings are kept.
4. **Wi-Fi.** The display scans and the page lists the networks it can see. Pick yours and type the password.
5. **Options.** Name the display (default "Desk display") and choose whether to **Include my private chats**.
6. **Finish.** The page creates the display's key itself and sends everything to the display in one step. You never see or copy a token. When the display reaches the server, the page says **Your display is live**. You can then unplug it and power it from any USB charger.

If something goes wrong, the page tells you what: the Wi-Fi password was rejected, the network wasn't found, joining Wi-Fi timed out, or the server rejected the key. Fix it and click **Try again**. A key whose display never came online (setup failed, timed out, was restarted or you left the page) is revoked automatically, and the next attempt creates a new one.

## Only 2.4 GHz Wi-Fi

The display's chip has no 5 GHz radio. It can't see or join a 5 GHz-only network, which is why the page only lists networks the display itself found. If your router has separate names for 2.4 GHz and 5 GHz, pick the 2.4 GHz one. A single name for both bands works.

## Private chats

With **Include my private chats**, the display also shows your own direct conversations with each agent (only yours, never other people's). Anyone who can see the screen can read them, so only enable it on a display you control.

## Managing displays

**Settings → Displays** lists every display key: its name, when it was created, when it was last used and whether private chats are on. **Revoke** a key when a display leaves your desk; the display stops updating straight away. To move a display to another network or server, run the setup again: it replaces the saved settings.

## Without Chrome or Edge

Hold the screen for 5 seconds. The display opens its own Wi-Fi network, **EmperorClaw-Display**, protected by a random password (like `k7mp-x3qa-9fhd`) shown on the screen. Join it from a phone or laptop, pick your Wi-Fi from the list and paste a **Read only** token created under **Settings → Access Tokens**. If you change the server URL there, paste a new token too: the saved one is erased.

## Secure connection

The display verifies the server's HTTPS certificate against the standard public certificate authorities, so use your Emperor Claw's `https://` address. Plain `http://` only works on a private network (addresses like `192.168.x.x`, `10.x.x.x`, `172.16-31.x.x` or `*.local` names). The setup page refuses to configure a display when you opened Emperor Claw over `http://` on a public address; open it through its `https://` address instead. A serial console (115200 baud) is also available; see the firmware README.

## Troubleshooting

- **The browser doesn't list the display.** Use a data cable (some USB-C cables only charge) and close any other app that has the port open, such as a serial monitor.
- **USB disconnects after Wi-Fi starts.** Wi-Fi transmit bursts can briefly drop the USB link on some ports and cables. The firmware starts Wi-Fi 3 seconds after boot and limits transmit power to reduce this. If it still happens, plug into a port on the computer itself instead of a hub. Setup can still finish: the page also checks with the server whether the display's key has been used.
- **Install fails to start.** Hold the **BOOT** button while plugging the display in, then try again.
