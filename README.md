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

For deployment, set `PUBLIC_BASE_URL` to the deployed HTTPS origin:

```text
PUBLIC_BASE_URL=https://virtual-calling-twilio.vercel.app
```

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
- For India (`+91`) destinations, set `INDIA_CALLER_ID` to a Twilio-owned or
  verified outgoing caller ID if carriers reject your default `TWILIO_NUMBER`.

## Operational Diagnostics

Before a browser-to-phone call, the app runs a server-side preflight check:

- validates SID prefixes and phone number formats
- verifies the Twilio account is reachable
- verifies `TWILIO_NUMBER` belongs to the account
- logs country-specific guidance for the destination

The TwiML also attaches a Twilio status callback to the dialed phone leg:

```text
https://your-public-url.example.com/call-events
```

Those callback events are logged by the server and can be queried from:

```text
/api/call-events
```

On serverless platforms such as Vercel, callback requests and browser polling may
hit different runtime instances. For durable diagnostics, the UI also queries
Twilio's Calls API after disconnect:

```text
/api/recent-calls?to=+14155552671
/api/call-diagnostics?callSid=CAxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx&to=+14155552671
```

`/api/call-diagnostics` fetches the browser leg by exact Call SID, then attempts
to fetch child phone legs by `ParentCallSid`. This avoids confusing the current
call with older calls to the same destination.

Error `31603` means Twilio or the destination carrier declined the call. For
India (`+91`) calls, first confirm Twilio Voice Geo Permissions for India, then
set `INDIA_CALLER_ID` to a verified India caller ID if available, and check
Twilio Monitor > Logs > Calls for the child call SID and carrier response.
