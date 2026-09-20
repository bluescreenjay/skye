# Skye mobile companion

Run `pnpm --filter @ai-browser/mobile dev -- --host 0.0.0.0` and open `http://<computer-lan-ip>:5174` on a phone connected to the same network. Set `VITE_API_BASE_URL` to the web API origin. Desktop Home creates a pairing code; the phone redeems it at `/pair`.

The API currently allows cross-origin Bearer requests for this separate web app. Set `MOBILE_ORIGIN` on the web server to make QR links point at a deployed companion URL (it defaults to `http://localhost:5174`).
