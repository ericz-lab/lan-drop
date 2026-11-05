# LAN Drop / 局域网快传

Send files and text between phones and computers on the same Wi-Fi, in the browser.

1. Open the app's LAN address on each device (the page shows it with a QR code), e.g. `http://192.168.1.20:9110/`.
2. Devices that have the page open appear to each other at once.
3. Tap a device (or drop files on it) to send; the other side accepts or declines. Received files download from the transfer list. "Text" sends a message or a link.

Optional: set `LANDROP_PIN=1234` in the app's `.env` so other devices must enter the PIN before they join.

Files travel through the machine that runs the app and are deleted an hour after a transfer ends.
