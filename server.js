const crypto = require("crypto");
const fs = require("fs");
const http = require("http");
const path = require("path");

const port = Number(process.env.PORT || 3100);
const publicDir = path.join(__dirname, "public");
const e164Pattern = /^\+[1-9]\d{7,14}$/;

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

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function buildDialTwiml(friendNumber) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    "<Say>Connecting your call now.</Say>",
    `<Dial callerId="${escapeXml(env("TWILIO_NUMBER"))}" answerOnBridge="true" timeout="45" action="/dial-result" method="POST">`,
    `<Number>${escapeXml(friendNumber)}</Number>`,
    "</Dial>",
    "</Response>",
  ].join("");
}

function buildBrowserCallTwiml(to) {
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<Response>",
    `<Dial callerId="${escapeXml(env("TWILIO_NUMBER"))}" answerOnBridge="true" timeout="45" action="/dial-result" method="POST">`,
    `<Number>${escapeXml(to)}</Number>`,
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
  const apiKeySid = env("TWILIO_API_KEY_SID");
  const apiKeySecret = env("TWILIO_API_KEY_SECRET");
  const accountSid = env("TWILIO_ACCOUNT_SID");

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
          application_sid: env("TWILIO_TWIML_APP_SID"),
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
  return {
    defaultMyNumber: optionalEnv("DEFAULT_MY_PHONE_NUMBER"),
    defaultFriendNumber: optionalEnv("DEFAULT_FRIEND_PHONE_NUMBER"),
    twilioNumber: optionalEnv("TWILIO_NUMBER"),
    twimlAppSid: optionalEnv("TWILIO_TWIML_APP_SID"),
    browserCallingConfigured: Boolean(
      optionalEnv("TWILIO_ACCOUNT_SID") &&
        optionalEnv("TWILIO_API_KEY_SID") &&
        optionalEnv("TWILIO_API_KEY_SECRET") &&
        optionalEnv("TWILIO_TWIML_APP_SID")
    ),
  };
}

async function routeApi(req, res, url) {
  if (req.method === "GET" && url.pathname === "/api/config") {
    writeJson(res, 200, getConfig());
    return true;
  }

  if (req.method === "GET" && url.pathname === "/api/token") {
    try {
      const identity = url.searchParams.get("identity") || `web-${crypto.randomUUID()}`;
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
      writeXml(res, 200, buildBrowserCallTwiml(to));
    } catch (error) {
      writeXml(res, 200, buildMessageTwiml(error.message || "The call could not be placed."));
    }
    return true;
  }

  if ((req.method === "GET" || req.method === "POST") && url.pathname === "/dial-result") {
    const data = await readRequestData(req, url);
    writeXml(res, 200, buildDialResultTwiml(String(data.DialCallStatus || "").trim()));
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
        Twiml: buildDialTwiml(friendNumber),
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
