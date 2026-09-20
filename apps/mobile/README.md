# Skye mobile companion

Run `pnpm --filter @ai-browser/mobile dev -- --host 0.0.0.0` and open `http://<computer-lan-ip>:5174` on a phone connected to the same network. By default, the app uses the same host on port 3000 for the API; set `VITE_API_BASE_URL` when the API has a different origin. Desktop Home creates a pairing code; the phone redeems it at `/pair`.

The API currently allows cross-origin Bearer requests for this separate web app. Set `MOBILE_ORIGIN` on the web server to make QR links point at a deployed companion URL (it defaults to `http://localhost:5174`).

## Voice and project assistant

The workspace chat composer and **All projects** view accept short voice recordings. **Voice chat** is a private voice turn: it records, ends automatically after about 1.2 seconds of silence once speech has started, sends audio to the authenticated API, asks the assistant, and speaks the answer through ElevenLabs without putting the user’s transcript in the composer or conversation. If ElevenLabs has no remaining credits, the browser’s built-in speech voice is used as a fallback. The separate **speak** control remains available when you want to dictate editable text. Configure `ELEVENLABS_API_KEY` on the web server only; set `ELEVENLABS_VOICE_ID` to choose a voice. Voice is unavailable without the key; typed chat continues to work. Phone microphone access needs HTTPS or a localhost origin. Recordings stop after 20 seconds and the server rejects audio larger than 2.5 MB.

All-projects chat reads a bounded set of the paired person's workspaces and displays its checked/total coverage and workspace sources. Each assistant answer has an action field for “make a Notion page for that” or “email me that.” Preparing an action makes no external write. Review the destination and full content before creating a page or preparing an email. Email needs a manually entered recipient and a second **Send email** tap. Recent proposals are shown on the All projects page after reload.

Apply `packages/shared/sql/015_project_assistant.sql` to the server database before using All projects or actions. Notion and Gmail also require the existing 010b integration settings; Gmail is restricted to `INTEGRATION_OWNER_USER_ID`.
