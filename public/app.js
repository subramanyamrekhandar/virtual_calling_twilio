const state = {
  device: null,
  activeCall: null,
  bridgeCallSid: "",
};

const elements = {
  connectionState: document.querySelector("#connectionState"),
  identity: document.querySelector("#identity"),
  browserFriendNumber: document.querySelector("#browserFriendNumber"),
  myNumber: document.querySelector("#myNumber"),
  bridgeFriendNumber: document.querySelector("#bridgeFriendNumber"),
  registerDeviceButton: document.querySelector("#registerDeviceButton"),
  browserCallButton: document.querySelector("#browserCallButton"),
  agentTestButton: document.querySelector("#agentTestButton"),
  hangupBrowserButton: document.querySelector("#hangupBrowserButton"),
  bridgeCallButton: document.querySelector("#bridgeCallButton"),
  checkBridgeButton: document.querySelector("#checkBridgeButton"),
  hangupBridgeButton: document.querySelector("#hangupBridgeButton"),
  browserCallForm: document.querySelector("#browserCallForm"),
  bridgeCallForm: document.querySelector("#bridgeCallForm"),
  clearLogButton: document.querySelector("#clearLogButton"),
  callLog: document.querySelector("#callLog"),
};

function setConnectionState(text, mode = "") {
  elements.connectionState.textContent = text;
  elements.connectionState.className = `status-pill ${mode}`.trim();
}

function log(message, type = "") {
  const item = document.createElement("li");
  if (type) {
    item.className = type;
  }

  const time = document.createElement("time");
  time.dateTime = new Date().toISOString();
  time.textContent = new Date().toLocaleTimeString();

  const body = document.createElement("span");
  body.textContent = message;

  item.append(time, body);
  elements.callLog.prepend(item);
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) {
    throw new Error(data.error || `Request failed: ${response.status}`);
  }
  return data;
}

function requirePhoneNumber(input, label) {
  const value = input.value.trim();
  if (!/^\+[1-9]\d{7,14}$/.test(value)) {
    throw new Error(`${label} must look like +14155552671`);
  }
  return value;
}

function describeCallError(error) {
  const details = [
    error.code ? `code ${error.code}` : "",
    error.name || "",
    error.message || "",
    error.description || "",
    error.explanation || "",
  ]
    .filter(Boolean)
    .join(" - ");

  if (error && Number(error.code) === 31005) {
    return `ConnectionError (31005): Twilio signaling disconnected. ${details}`;
  }

  return details || "Browser call error.";
}

function wireCallEvents(call) {
  call.on("accept", () => {
    setConnectionState("Call live", "live");
    elements.hangupBrowserButton.disabled = false;
    log("Browser connected to Twilio. Waiting for the phone leg to answer.", "success");
  });
  call.on("disconnect", () => {
    state.activeCall = null;
    setConnectionState("Browser ready", "ready");
    elements.hangupBrowserButton.disabled = true;
    elements.browserCallButton.disabled = false;
    elements.agentTestButton.disabled = false;
    log("Call ended or the phone leg disconnected.");
  });
  call.on("cancel", () => log("Browser call canceled."));
  call.on("reject", () => log("Browser call rejected.", "error"));
  call.on("error", (error) => log(describeCallError(error), "error"));
}

async function registerDevice() {
  if (!window.Twilio || !window.Twilio.Device) {
    throw new Error("Twilio Voice SDK is not loaded. Run npm install and restart the server.");
  }

  elements.registerDeviceButton.disabled = true;
  setConnectionState("Connecting...");

  const identity = (elements.identity.value.trim() || "web_user").replace(/[^A-Za-z0-9_]/g, "_").slice(0, 121);
  elements.identity.value = identity;
  const { token } = await api(`/api/token?identity=${encodeURIComponent(identity)}`);

  if (state.device) {
    state.device.destroy();
  }

  state.device = new window.Twilio.Device(token, {
    edge: ["singapore", "sydney", "tokyo", "ashburn"],
    enableImprovedSignalingErrorPrecision: true,
    logLevel: 1,
    maxCallSignalingTimeoutMs: 30000,
  });

  state.device.on("registered", () => {
    setConnectionState("Browser ready", "ready");
    elements.browserCallButton.disabled = false;
    elements.agentTestButton.disabled = false;
    elements.registerDeviceButton.disabled = false;
    log(`Browser registered as ${identity}.`, "success");
  });

  state.device.on("unregistered", () => {
    setConnectionState("Not connected");
    elements.browserCallButton.disabled = true;
    elements.agentTestButton.disabled = true;
    log("Browser device unregistered.");
  });

  state.device.on("error", (error) => {
    setConnectionState("Device error");
    elements.registerDeviceButton.disabled = false;
    log(describeCallError(error), "error");
  });

  await state.device.register();
}

async function startBrowserCall(event) {
  event.preventDefault();
  const friendNumber = requirePhoneNumber(elements.browserFriendNumber, "Friend phone number");

  if (!state.device) {
    throw new Error("Connect the browser first.");
  }

  elements.browserCallButton.disabled = true;
  setConnectionState("Dialing...", "live");
  log(`Dialing ${friendNumber} from browser.`);

  state.activeCall = await state.device.connect({
    params: { To: friendNumber },
  });
  wireCallEvents(state.activeCall);
}

async function startAgentTest() {
  if (!state.device) {
    throw new Error("Connect the browser first.");
  }

  elements.browserCallButton.disabled = true;
  elements.agentTestButton.disabled = true;
  setConnectionState("Calling agent...", "live");
  log("Calling Twilio test agent.");

  state.activeCall = await state.device.connect({
    params: { To: "agent:test" },
  });
  wireCallEvents(state.activeCall);
}

async function startBridgeCall(event) {
  event.preventDefault();
  const myNumber = requirePhoneNumber(elements.myNumber, "Your phone number");
  const friendNumber = requirePhoneNumber(elements.bridgeFriendNumber, "Friend phone number");

  elements.bridgeCallButton.disabled = true;
  log(`Starting bridge: ${myNumber} -> ${friendNumber}.`);

  const data = await api("/api/bridge-call", {
    method: "POST",
    body: JSON.stringify({ myNumber, friendNumber }),
  });

  state.bridgeCallSid = data.sid;
  elements.checkBridgeButton.disabled = false;
  elements.hangupBridgeButton.disabled = false;
  elements.bridgeCallButton.disabled = false;
  log(`${data.message} Call SID: ${data.sid}`, "success");
}

async function checkBridgeStatus() {
  if (!state.bridgeCallSid) {
    return;
  }
  const data = await api(`/api/calls/${state.bridgeCallSid}`);
  log(`Bridge ${data.sid}: ${data.status}${data.duration ? `, ${data.duration}s` : ""}.`);
}

async function hangupBridgeCall() {
  if (!state.bridgeCallSid) {
    return;
  }
  const data = await api(`/api/calls/${state.bridgeCallSid}/hangup`, { method: "POST" });
  elements.hangupBridgeButton.disabled = true;
  log(`Bridge ${data.sid} ended with status ${data.status}.`);
}

async function loadConfig() {
  const config = await api("/api/config");
  elements.myNumber.value = config.defaultMyNumber || "";
  elements.bridgeFriendNumber.value = config.defaultFriendNumber || "";
  elements.browserFriendNumber.value = config.defaultFriendNumber || "";

  if (!config.browserCallingConfigured) {
    log("Browser calling needs TWILIO_API_KEY_SID, TWILIO_API_KEY_SECRET, and TWILIO_TWIML_APP_SID.", "error");
    for (const error of config.configErrors || []) {
      log(error, "error");
    }
  } else {
    log(`Config loaded. TwiML App ${config.twimlAppSid || "unknown"}, caller ID ${config.twilioNumber || "unknown"}.`);
  }
}

function bindEvents() {
  elements.registerDeviceButton.addEventListener("click", () => {
    registerDevice().catch((error) => log(error.message, "error"));
  });

  elements.agentTestButton.addEventListener("click", () => {
    startAgentTest().catch((error) => {
      elements.browserCallButton.disabled = false;
      elements.agentTestButton.disabled = false;
      setConnectionState(state.device ? "Browser ready" : "Not connected", state.device ? "ready" : "");
      log(error.message, "error");
    });
  });

  elements.browserCallForm.addEventListener("submit", (event) => {
    startBrowserCall(event).catch((error) => {
      elements.browserCallButton.disabled = false;
      elements.agentTestButton.disabled = false;
      setConnectionState(state.device ? "Browser ready" : "Not connected", state.device ? "ready" : "");
      log(error.message, "error");
    });
  });

  elements.hangupBrowserButton.addEventListener("click", () => {
    if (state.activeCall) {
      state.activeCall.disconnect();
    }
  });

  elements.bridgeCallForm.addEventListener("submit", (event) => {
    startBridgeCall(event).catch((error) => {
      elements.bridgeCallButton.disabled = false;
      log(error.message, "error");
    });
  });

  elements.checkBridgeButton.addEventListener("click", () => {
    checkBridgeStatus().catch((error) => log(error.message, "error"));
  });

  elements.hangupBridgeButton.addEventListener("click", () => {
    hangupBridgeCall().catch((error) => log(error.message, "error"));
  });

  elements.clearLogButton.addEventListener("click", () => {
    elements.callLog.replaceChildren();
  });
}

bindEvents();
loadConfig().catch((error) => log(error.message, "error"));

if (window.lucide) {
  window.lucide.createIcons({
    attrs: {
      "stroke-width": 2,
    },
  });
}
