# Twilio Web Calling App

Single Node.js server with:

- Backend API for Twilio tokens, TwiML, call status, and phone bridging.
- Frontend web UI for browser calls and two-leg mobile bridge calls.

## Setup

Copy `.env.example` to `.env` and fill in real values:

```powershell
Copy-Item .env.example .env
```

All phone numbers must be in E.164 format, for example `+14155552671`.

## Run

```powershell
node server.js
```

Open:

```text
http://localhost:3100
```

## Browser Calling Setup

Browser calling uses the Twilio Voice SDK. In Twilio Console:

1. Create an API Key and Secret.
2. Create a TwiML App.
3. Set the TwiML App Voice Request URL to your public server URL:

```text
https://your-public-url.example.com/voice
```

The app accepts both `GET` and `POST` for this URL, so either Twilio request
method will work.

For local testing, expose this server with a tunnel such as ngrok or Cloudflare
Tunnel, then use the tunnel URL in the TwiML App.

## Phone Bridge Setup

The phone bridge does not need a public webhook. The server asks Twilio to call
your phone first. When you answer, Twilio dials your friend's number and bridges
the call.

## Notes

- `TWILIO_NUMBER` must be a Twilio number that can make outbound voice calls.
- Your Twilio account must be permitted to call the destination country.
- If your account is still in trial mode, verified caller ID restrictions may apply.
- Browser calling requires microphone permission in your browser.
- This version uses only built-in Node.js modules, so no `npm install` is required.

## Operational Diagnostics

Before a browser-to-phone call, the app runs a server-side preflight check:

- validates SID prefixes and phone number formats
- verifies the Twilio account is reachable
- verifies `TWILIO_NUMBER` belongs to the account
- logs country-specific guidance for the destination

The TwiML also attaches a Twilio status callback to the dialed phone leg:

```text
/call-events
```

Those callback events are logged by the server and can be queried from:

```text
/api/call-events
```

Error `31603` means Twilio or the destination carrier declined the call. For
India (`+91`) calls, first confirm Twilio Voice Geo Permissions for India, then
check Twilio Monitor > Logs > Calls for the child call SID and carrier response.
