# LAN Drop / 局域网快传

Send files and text between phones and computers on the same Wi-Fi, in the browser.

1. Open the app's LAN address on each device (the page shows it with a QR code), e.g. `http://192.168.1.20:9110/`.
2. Devices that have the page open appear to each other at once.
3. Tap a device (or drop files on it) to send; the other side accepts or declines. Received files download from the transfer list. "Text" sends a message or a link.

Optional: set `LANDROP_PIN=1234` in the app's `.env` so other devices must enter the PIN before they join.

Optional direct path for pages opened through the domain: point a DNS-only name at the host's LAN address, get a certificate for it, and set

```
LANDROP_TLS_PORT=9111
LANDROP_TLS_CERT=/path/fullchain.pem
LANDROP_TLS_KEY=/path/key.pem
LANDROP_DIRECT_URL=https://lan.example.org:9111/
LANDROP_PAGE_ORIGINS=https://lan-drop.example.org
```

At home the page then sends and fetches file bytes over the LAN without leaving the domain page (Chrome may ask once to allow access to the local network); away from home it keeps using the domain.

Files travel through the machine that runs the app and are deleted an hour after a transfer ends.
