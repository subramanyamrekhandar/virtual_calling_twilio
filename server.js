const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const port = Number(process.env.PORT || 3100);
const publicDir = path.join(__dirname, "public");
const e164Pattern = /^\+[1-9]\d{7,14}$/;
const recentCallEvents = [];

loadDotEnv();

function loadDotEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) {
    return;
  }

  const lines = fs.readFileSync(envPath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const equalsIndex = trimmed.indexOf("=");
    if (equalsIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, equalsIndex).trim();
    const value = trimmed.slice(equalsIndex + 1).trim();
    if (key && process.env[key] === undefined) {
      process.env[key] = value.replace(/^["']|["']$/g, "");
    }
  }
}

function env(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value.trim();
}

function optionalEnv(name) {
  return process.env[name] ? process.env[name].trim() : "";
}

function validatePhoneNumber(value, label) {
  if (!value || !e164Pattern.test(value)) {
    throw new Error(`${label} must be an E.164 phone number like +14155552671`);
  }
  return value;
}

function maskValue(value, visible = 4) {
  if (!value) {
    return "";
  }
  return `${value.slice(0, 2)}...${value.slice(-visible)}`;
}

function destinationGuidance(phoneNumber) {
  if (phoneNumber.startsWith("+91")) {
    const guidance = [
      "Destination is India (+91). Confirm Twilio Voice Geo Permissions allow India.",
      "Open Twilio Monitor > Logs > Calls for the exact declined child call.",
    ];
    if (optionalEnv("INDIA_CALLER_ID")) {
      guidance.push("Using INDIA_CALLER_ID for India calls. Confirm it is verified in Twilio.");
    } else {
      guidance.push("Some India carriers reject international caller IDs. Set INDIA_CALLER_ID to a verified India caller ID if available.");
      guidance.push("Test a US destination to isolate carrier routing.");
    }
    return guidance;
  }

  if (phoneNumber.startsWith("+1")) {
    return ["Destination is NANP (+1). If this fails, check caller ID, account status, and Twilio call logs."];
  }

  return ["Confirm Twilio Voice Geo Permissions and carrier support for this destination country."];
}

function recordCallEvent(event) {
  recentCallEvents.unshift({
    at: new Date().toISOString(),
    ...event,
  });

  recentCallEvents.splice(100);
  console.log("Twilio call event", JSON.stringify(recentCallEvents[0]));
}

function getPublicBaseUrl(req) {
  const configuredUrl = optionalEnv("PUBLIC_BASE_URL").replace(/\/$/, "");
  if (configuredUrl) {
    return configuredUrl;
  }

  const proto = req.headers["x-forwarded-proto"] || "https";
  const host = req.headers["x-forwarded-host"] || req.headers.host;
  return `${String(proto).split(",")[0]}://${String(host).split(",")[0]}`;
}

function validateSid(name, prefix) {
  const value = env(name);
  if (!value.startsWith(prefix)) {
    throw new Error(`${name} must start with ${prefix}. Current value starts with ${value.slice(0, 2) || "nothing"}.`);
  }
  return value;
}

function sanitizeIdentity(value) {
  const identity = String(value || "web_user")
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .slice(0, 121);

  return identity || "web_user";
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildStatusCallbackAttrs(baseUrl, clientCallId) {
  const query = clientCallId ? `?clientCallId=${encodeURIComponent(clientCallId)}` : "";
  return `statusCallback="${escapeXml(`${baseUrl}/call-events${query}`)}" statusCallbackMethod="POST" statusCallbackEvent="initiated ringing answered completed"`;
}

function buildDialActionAttr(baseUrl, clientCallId) {
  const query = clientCallId ? `?clientCallId=${encodeURIComponent(clientCallId)}` : "";
  return `action="${escapeXml(`${baseUrl}/dial-result${query}`)}"`;
}

function callerIdEnvNameForDestination(phoneNumber) {
  if (phoneNumber.startsWith("+91") && optionalEnv("INDIA_CALLER_ID")) {
    return "INDIA_CALLER_ID";
  }
  return "TWILIO_NUMBER";
}

function callerIdForDestination(phoneNumber) {
  return env(callerIdEnvNameForDestination(phoneNumber));
}

function buildDialTwiml(friendNumber, clientCallId = "", baseUrl = "") {
  const resolvedBaseUrl = baseUrl || optionalEnv("PUBLIC_BASE_URL").replace(/\/$/, "");
  const callerId = callerIdForDestination(friendNumber);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "<Say>Connecting your call now.</Say>",
    `<Dial callerId="${escapeXml(callerId)}" answerOnBridge="true" timeout="45" ${buildDialActionAttr(resolvedBaseUrl, clientCallId)} method="POST">`,
    `<Number ${buildStatusCallbackAttrs(resolvedBaseUrl, clientCallId)}>${escapeXml(friendNumber)}</Number>`,
    "</Dial>",
    "</Response>",
  ].join("");
}

function buildBrowserCallTwiml(to, clientCallId = "", baseUrl = "") {
  const resolvedBaseUrl = baseUrl || optionalEnv("PUBLIC_BASE_URL").replace(/\/$/, "");
  const callerId = callerIdForDestination(to);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `<Dial callerId="${escapeXml(callerId)}" answerOnBridge="true" timeout="45" ${buildDialActionAttr(resolvedBaseUrl, clientCallId)} method="POST">`,
    `<Number ${buildStatusCallbackAttrs(resolvedBaseUrl, clientCallId)}>${escapeXml(to)}</Number>`,
    "</Dial>",
    "</Response>",
  ].join("");
}

function buildAgentTestTwiml() {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "<Say voice=\"alice\">Your browser is connected to the Twilio test agent.</Say>",
    "<Pause length=\"1\"/>",
    "<Say voice=\"alice\">If you can hear this message, browser audio is working. The phone call leg is the part that needs debugging.</Say>",
    "</Response>",
  ].join("");
}

function buildMessageTwiml(message) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `<Say>${escapeXml(message)}</Say>`,
    "</Response>",
  ].join("");
}

function buildDialResultTwiml(status) {
  const responseByStatus = {
    answered: "The destination answered, and the call has ended.",
    completed: "The call has ended.",
    busy: "The destination number was busy.",
    "no-answer": "The destination did not answer.",
    failed: "Twilio could not connect the destination number.",
    canceled: "The destination call was canceled.",
  };

  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `<Say>${escapeXml(responseByStatus[status] || `The call ended with status ${status || "unknown"}.`)}</Say>`,
    "<Hangup/>",
    "</Response>",
  ].join("");
}

function base64UrlJson(value) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function createVoiceToken(identity) {
  const now = Math.floor(Date.now() / 1000);
  const apiKeySid = validateSid("TWILIO_API_KEY_SID", "SK");
  const apiKeySecret = env("TWILIO_API_KEY_SECRET");
  const accountSid = validateSid("TWILIO_ACCOUNT_SID", "AC");
  const twimlAppSid = validateSid("TWILIO_TWIML_APP_SID", "AP");

  const header = {
    typ: "JWT",
    alg: "HS256",
    cty: "twilio-fpa;v=1",
  };

  const payload = {
    jti: `${apiKeySid}-${now}`,
    iss: apiKeySid,
    sub: accountSid,
    exp: now + 3600,
    grants: {
      identity,
      voice: {
        outgoing: {
          application_sid: twimlAppSid,
        },
        incoming: {
          allow: false,
        },
      },
    },
  };

  const unsignedToken = `${base64UrlJson(header)}.${base64UrlJson(payload)}`;
  const signature = crypto
    .createHmac("sha256", apiKeySecret)
    .update(unsignedToken)
    .digest("base64url");

  return `${unsignedToken}.${signature}`;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function readRequestData(req, url) {
  if (req.method === "GET") {
    return Object.fromEntries(url.searchParams.entries());
  }

  const rawBody = await readBody(req);
  const contentType = req.headers["content-type"] || "";

  if (contentType.includes("application/json")) {
    return rawBody ? JSON.parse(rawBody) : {};
  }

  return Object.fromEntries(new URLSearchParams(rawBody).entries());
}

function writeJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function writeXml(res, status, xml) {
  res.writeHead(status, {
    "Content-Type": "text/xml; charset=utf-8",
    "Content-Length": Buffer.byteLength(xml),
  });
  res.end(xml);
}

function writeText(res, status, text) {
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
  });
  res.end(text);
}

function sendError(res, status, error) {
  writeJson(res, status, { error: error.message || String(error) });
}

async function twilioRequest(method, apiPath, formData) {
  const accountSid = env("TWILIO_ACCOUNT_SID");
  const authToken = env("TWILIO_AUTH_TOKEN");
  const response = await fetch(`https://api.twilio.com${apiPath}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: formData ? new URLSearchParams(formData) : undefined,
  });

  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    throw new Error(data.message || `Twilio API error: ${response.status}`);
  }
  return data;
}

function getConfig() {
  const twimlAppSid = optionalEnv("TWILIO_TWIML_APP_SID");
  const accountSid = optionalEnv("TWILIO_ACCOUNT_SID");
  const apiKeySid = optionalEnv("TWILIO_API_KEY_SID");
  const configErrors = [];

  if (accountSid && !accountSid.startsWith("AC")) {
    configErrors.push("TWILIO_ACCOUNT_SID must start with AC.");
  }
  if (apiKeySid && !apiKeySid.startsWith("SK")) {
    configErrors.push("TWILIO_API_KEY_SID must start with SK.");
  }
  if (twimlAppSid && !twimlAppSid.startsWith("AP")) {
    configErrors.push("TWILIO_TWIML_APP_SID must start with AP. You currently have an Account SID or another wrong value there.");
  }

  return {
    defaultMyNumber: optionalEnv("DEFAULT_MY_PHONE_NUMBER"),
    defaultFriendNumber: optionalEnv("DEFAULT_FRIEND_PHONE_NUMBER"),
    twilioNumber: optionalEnv("TWILIO_NUMBER"),
    indiaCallerId: optionalEnv("INDIA_CALLER_ID"),
    twimlAppSid,
    configErrors,
    browserCallingConfigured: Boolean(
      accountSid &&
        apiKeySid &&
        optionalEnv("TWILIO_API_KEY_SECRET") &&
        twimlAppSid &&
        configErrors.length === 0
    ),
  };
}

function compactCall(call) {
  return {
    sid: call.sid,
    parentCallSid: call.parent_call_sid,
    from: call.from,
    to: call.to,
    status: call.status,
    direction: call.direction,
    duration: call.duration,
    startTime: call.start_time,
    endTime: call.end_time,
    price: call.price,
    priceUnit: call.price_unit,
    errorCode: call.error_code,
  };
}

async function verifyCallerId(accountSid, callerId, diagnostics) {
  validatePhoneNumber(callerId, "Caller ID");

  const numberQuery = encodeURIComponent(callerId);
  const numbers = await twilioRequest(
    "GET",
    `/2010-04-01/Accounts/${accountSid}/IncomingPhoneNumbers.json?PhoneNumber=${numberQuery}`
  );
  const ownedNumber = Array.isArray(numbers.incoming_phone_numbers)
    ? numbers.incoming_phone_numbers[0]
    : null;

  if (ownedNumber) {
    diagnostics.checks.push(`Caller ID belongs to this account: ${ownedNumber.phone_number}.`);
    if (ownedNumber.capabilities && ownedNumber.capabilities.voice !== true) {
      diagnostics.errors.push("Selected caller ID does not have Voice capability.");
    }
    return;
  }

  const outgoingCallerIds = await twilioRequest(
    "GET",
    `/2010-04-01/Accounts/${accountSid}/OutgoingCallerIds.json?PhoneNumber=${numberQuery}`
  );
  const verifiedCallerId = Array.isArray(outgoingCallerIds.outgoing_caller_ids)
    ? outgoingCallerIds.outgoing_caller_ids[0]
    : null;

  if (verifiedCallerId) {
    diagnostics.checks.push(`Caller ID is verified in this account: ${verifiedCallerId.phone_number}.`);
    return;
  }

  diagnostics.errors.push("Selected caller ID must be a Twilio number on this account or a verified outgoing caller ID.");
}

async function buildPreflight(to) {
  const callerIdEnvName = callerIdEnvNameForDestination(to);
  const callerId = optionalEnv(callerIdEnvName);
  const diagnostics = {
    ok: true,
    destination: to,
    callerId,
    callerIdEnvName,
    accountSid: maskValue(optionalEnv("TWILIO_ACCOUNT_SID")),
    apiKeySid: maskValue(optionalEnv("TWILIO_API_KEY_SID")),
    twimlAppSid: maskValue(optionalEnv("TWILIO_TWIML_APP_SID")),
    twilioNumber: optionalEnv("TWILIO_NUMBER"),
    checks: [],
    warnings: destinationGuidance(to),
    errors: [],
  };

  const config = getConfig();
  diagnostics.errors.push(...config.configErrors);

  try {
    validatePhoneNumber(to, "Friend phone number");
  } catch (error) {
    diagnostics.errors.push(error.message);
  }

  try {
    validatePhoneNumber(callerId, callerIdEnvName);
  } catch (error) {
    diagnostics.errors.push(error.message);
  }

  if (!config.browserCallingConfigured) {
    diagnostics.errors.push("Browser calling is not fully configured.");
  }

  if (diagnostics.errors.length === 0) {
    const accountSid = validateSid("TWILIO_ACCOUNT_SID", "AC");
    const account = await twilioRequest("GET", `/2010-04-01/Accounts/${accountSid}.json`);
    diagnostics.checks.push(`Twilio account status: ${account.status || "unknown"}.`);

    await verifyCallerId(accountSid, callerId, diagnostics);
  }

  diagnostics.ok = diagnostics.errors.length === 0;
  return diagnostics;
}

async function routeApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    writeJson(res, 200, getConfig());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/preflight") {
    try {
      const to = validatePhoneNumber(String(url.searchParams.get("to") || "").trim(), "Friend phone number");
      const diagnostics = await buildPreflight(to);
      writeJson(res, diagnostics.ok ? 200 : 400, diagnostics);
    } catch (error) {
      sendError(res, 400, error);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/call-events") {
    const clientCallId = String(url.searchParams.get("clientCallId") || "");
    const events = clientCallId
      ? recentCallEvents.filter((event) => event.clientCallId === clientCallId)
      : recentCallEvents.slice(0, 25);
    writeJson(res, 200, { events });
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/recent-calls") {
    try {
      const to = validatePhoneNumber(String(url.searchParams.get("to") || "").trim(), "Friend phone number");
      const startedAfter = String(url.searchParams.get("startedAfter") || "").trim();
      const accountSid = validateSid("TWILIO_ACCOUNT_SID", "AC");
      const calls = await twilioRequest(
        "GET",
        `/2010-04-01/Accounts/${accountSid}/Calls.json?To=${encodeURIComponent(to)}&PageSize=10`
      );
      const cutoff = startedAfter ? Date.parse(startedAfter) - 60000 : 0;
      const filteredCalls = Array.isArray(calls.calls)
        ? calls.calls.filter((call) => {
            if (!cutoff || !call.start_time) {
              return true;
            }
            return Date.parse(call.start_time) >= cutoff;
          })
        : [];
      writeJson(res, 200, {
        calls: filteredCalls.map(compactCall),
      });
    } catch (error) {
      sendError(res, 400, error);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/call-diagnostics") {
    try {
      const accountSid = validateSid("TWILIO_ACCOUNT_SID", "AC");
      const callSid = String(url.searchParams.get("callSid") || "").trim();
      const to = String(url.searchParams.get("to") || "").trim();
      const startedAfter = String(url.searchParams.get("startedAfter") || "").trim();
      const diagnostics = {
        call: null,
        childCalls: [],
        recentDestinationCalls: [],
      };

      if (callSid) {
        const call = await twilioRequest(
          "GET",
          `/2010-04-01/Accounts/${accountSid}/Calls/${encodeURIComponent(callSid)}.json`
        );
        diagnostics.call = compactCall(call);

        const children = await twilioRequest(
          "GET",
          `/2010-04-01/Accounts/${accountSid}/Calls.json?ParentCallSid=${encodeURIComponent(callSid)}&PageSize=10`
        );
        diagnostics.childCalls = Array.isArray(children.calls) ? children.calls.map(compactCall) : [];
      }

      if (to && e164Pattern.test(to)) {
        const calls = await twilioRequest(
          "GET",
          `/2010-04-01/Accounts/${accountSid}/Calls.json?To=${encodeURIComponent(to)}&PageSize=10`
        );
        const cutoff = startedAfter ? Date.parse(startedAfter) - 60000 : 0;
        diagnostics.recentDestinationCalls = Array.isArray(calls.calls)
          ? calls.calls
              .filter((call) => {
                if (!cutoff || !call.start_time) {
                  return true;
                }
                return Date.parse(call.start_time) >= cutoff;
              })
              .map(compactCall)
          : [];
      }

      writeJson(res, 200, diagnostics);
    } catch (error) {
      sendError(res, 400, error);
    }
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/token") {
    try {
      const identity = sanitizeIdentity(url.searchParams.get("identity") || `web_${crypto.randomUUID()}`);
      writeJson(res, 200, { identity, token: createVoiceToken(identity) });
    } catch (error) {
      sendError(res, 500, error);
    }
    return true;
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/voice") {
    try {
      const data = await readRequestData(req, url);
      if (String(data.To || "").trim() === "agent:test") {
        writeXml(res, 200, buildAgentTestTwiml());
        return true;
      }
      const to = validatePhoneNumber(String(data.To || "").trim(), "To");
      writeXml(res, 200, buildBrowserCallTwiml(to, String(data.ClientCallId || "").trim(), getPublicBaseUrl(req)));
    } catch (error) {
      writeXml(res, 200, buildMessageTwiml(error.message || "The call could not be placed."));
    }
    return true;
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/call-events") {
    const data = await readRequestData(req, url);
    recordCallEvent({
      clientCallId: String(data.clientCallId || url.searchParams.get("clientCallId") || ""),
      callSid: data.CallSid,
      parentCallSid: data.ParentCallSid,
      callStatus: data.CallStatus,
      to: data.To,
      from: data.From,
      sequenceNumber: data.SequenceNumber,
      errorCode: data.ErrorCode,
    });
    writeText(res, 200, "ok");
    return true;
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/dial-result") {
    const data = await readRequestData(req, url);
    const dialCallStatus = String(data.DialCallStatus || "").trim();
    recordCallEvent({
      eventType: "dial-result",
      clientCallId: String(url.searchParams.get("clientCallId") || ""),
      callSid: data.CallSid,
      dialCallSid: data.DialCallSid,
      dialCallStatus,
      dialCallDuration: data.DialCallDuration,
      dialBridged: data.DialBridged,
    });
    writeXml(res, 200, buildDialResultTwiml(dialCallStatus));
    return true;
  }

  if (req.method === "POST" && url.pathname === "/api/bridge-call") {
    try {
      const data = await readRequestData(req, url);
      const myNumber = validatePhoneNumber(
        String(data.myNumber || optionalEnv("DEFAULT_MY_PHONE_NUMBER")).trim(),
        "Your phone number"
      );
      const friendNumber = validatePhoneNumber(
        String(data.friendNumber || optionalEnv("DEFAULT_FRIEND_PHONE_NUMBER")).trim(),
        "Friend phone number"
      );
      const accountSid = env("TWILIO_ACCOUNT_SID");
      const call = await twilioRequest("POST", `/2010-04-01/Accounts/${accountSid}/Calls.json`, {
        To: myNumber,
        From: env("TWILIO_NUMBER"),
        Twiml: buildDialTwiml(friendNumber, crypto.randomUUID(), optionalEnv("PUBLIC_BASE_URL").replace(/\/$/, "")),
      });

      writeJson(res, 200, {
        sid: call.sid,
        status: call.status,
        message: `Calling ${myNumber}. After you answer, Twilio will dial ${friendNumber}.`,
      });
    } catch (error) {
      sendError(res, 400, error);
    }
    return true;
  }

  const statusMatch = url.pathname.match(/^\/api\/calls\/([^/]+)$/);
  if (req.method === "GET" && statusMatch) {
    try {
      const accountSid = env("TWILIO_ACCOUNT_SID");
      const call = await twilioRequest(
        "GET",
        `/2010-04-01/Accounts/${accountSid}/Calls/${encodeURIComponent(statusMatch[1])}.json`
      );
      writeJson(res, 200, {
        sid: call.sid,
        from: call.from,
        to: call.to,
        status: call.status,
        direction: call.direction,
        duration: call.duration,
        startTime: call.start_time,
        endTime: call.end_time,
        price: call.price,
        priceUnit: call.price_unit,
      });
    } catch (error) {
      sendError(res, 404, error);
    }
    return true;
  }

  const hangupMatch = url.pathname.match(/^\/api\/calls\/([^/]+)\/hangup$/);
  if (req.method === "POST" && hangupMatch) {
    try {
      const accountSid = env("TWILIO_ACCOUNT_SID");
      const call = await twilioRequest(
        "POST",
        `/2010-04-01/Accounts/${accountSid}/Calls/${encodeURIComponent(hangupMatch[1])}.json`,
        { Status: "completed" }
      );
      writeJson(res, 200, { sid: call.sid, status: call.status });
    } catch (error) {
      sendError(res, 400, error);
    }
    return true;
  }

  return false;
}

function serveStatic(req, res, url) {
  if (req.method !== "GET" && req.method !== "HEAD") {
    writeText(res, 405, "Method not allowed");
    return;
  }

  const requestPath = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const safePath = path.normalize(decodeURIComponent(requestPath));
  const filePath = path.resolve(publicDir, safePath);

  if (filePath !== publicDir && !filePath.startsWith(`${publicDir}${path.sep}`)) {
    writeText(res, 403, "Forbidden");
    return;
  }

  fs.readFile(filePath, (error, content) => {
    if (error) {
      writeText(res, 404, "Not found");
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType =
      {
        ".html": "text/html; charset=utf-8",
        ".css": "text/css; charset=utf-8",
        ".js": "application/javascript; charset=utf-8",
        ".json": "application/json; charset=utf-8",
      }[ext] || "application/octet-stream";

    res.writeHead(200, {
      "Content-Type": contentType,
      "Content-Length": content.length,
    });
    res.end(req.method === "HEAD" ? undefined : content);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const handled = await routeApi(req, res, url);
    if (!handled) {
      serveStatic(req, res, url);
    }
  } catch (error) {
    sendError(res, 500, error);
  }
});

server.listen(port, () => {
  console.log(`Twilio web calling app running at http://localhost:${port}`);
});
