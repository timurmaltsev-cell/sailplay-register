// Minimal Node.js backend that proxies registration requests to SailPlay.
// No npm dependencies — uses only Node built-ins. Requires Node 18+.
//
// Env vars:
//   SAILPLAY_PIN_CODE              (e.g. "802927")
//   SAILPLAY_STORE_DEPARTMENT_ID   (e.g. "5539")
//   SAILPLAY_STORE_DEPARTMENT_KEY  (e.g. "91163589")
//   (Optionally) PORT              (default 3000)
//
// The server logs in to SailPlay to obtain a short-lived token, caches it,
// and refreshes automatically when the token expires (~24h) or when an
// /users/add/ call comes back with an auth error.
//
// Docs: https://docs.retailrocket.net/docs/sailplay/clients/basics/

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const PIN_CODE = process.env.SAILPLAY_PIN_CODE;
const STORE_DEPARTMENT_ID = process.env.SAILPLAY_STORE_DEPARTMENT_ID;
const STORE_DEPARTMENT_KEY = process.env.SAILPLAY_STORE_DEPARTMENT_KEY;

const SAILPLAY_LOGIN_URL = "https://sailplay.ru/api/v2/login";
const SAILPLAY_USERS_ADD_URL = "https://api.sailplay.net/api/v2/users/add/";

// Refresh proactively well before the documented ~24h expiry.
const TOKEN_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

if (!PIN_CODE || !STORE_DEPARTMENT_ID || !STORE_DEPARTMENT_KEY) {
  console.warn(
    "[WARN] Missing SAILPLAY_PIN_CODE / SAILPLAY_STORE_DEPARTMENT_ID / SAILPLAY_STORE_DEPARTMENT_KEY. " +
    "Registration calls will fail with 500 until all three are configured."
  );
}

// --- static helpers ---
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pdf": "application/pdf",
};

function isValidEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

function normalizePhone(raw) {
  if (typeof raw !== "string") return null;
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("8")) d = "7" + d.slice(1);
  if (d.length === 11 && d.startsWith("7")) return d;
  return null;
}

function sendJSON(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req, limit = 32 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) {
        reject(new Error("payload_too_large"));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

async function serveStatic(req, res) {
  const url = req.url === "/" ? "/register.html" : req.url.split("?")[0];
  const safe = path.normalize(url).replace(/^([/\\])+/, "");
  const filePath = path.join(__dirname, safe);
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end("Forbidden"); return;
  }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    res.end(data);
  });
}

// --- SailPlay token cache + login ---
let cachedToken = null;
let cachedAt = 0;
let inFlightLogin = null; // dedupe concurrent logins

async function fetchFreshToken() {
  const params = new URLSearchParams({
    pin_code: PIN_CODE,
    store_department_id: STORE_DEPARTMENT_ID,
    store_department_key: STORE_DEPARTMENT_KEY,
  });
  const url = `${SAILPLAY_LOGIN_URL}?${params.toString()}`;
  const r = await fetch(url, { method: "GET", headers: { Accept: "application/json" } });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  // Try common shapes for "token" — SailPlay has historically used a few.
  const token =
    data?.token ||
    data?.access_token ||
    data?.result?.token ||
    data?.data?.token ||
    null;
  if (!r.ok || !token) {
    const reason = data?.message || data?.raw || `HTTP ${r.status}`;
    throw new Error(`SailPlay login failed: ${reason}`);
  }
  return String(token);
}

async function getToken({ force = false } = {}) {
  const fresh = !force && cachedToken && (Date.now() - cachedAt) < TOKEN_TTL_MS;
  if (fresh) return cachedToken;
  if (inFlightLogin) return inFlightLogin;
  inFlightLogin = (async () => {
    const t = await fetchFreshToken();
    cachedToken = t;
    cachedAt = Date.now();
    console.log("[sailplay] obtained fresh token");
    return t;
  })().finally(() => { inFlightLogin = null; });
  return inFlightLogin;
}

// Detect SailPlay responses that imply the token is invalid/expired.
// Auth-related status_codes vary; we treat anything plausibly auth-related as a token issue.
function isTokenError(data, httpStatus) {
  if (httpStatus === 401 || httpStatus === 403) return true;
  if (!data || data.status !== "error") return false;
  const code = Number(data.status_code);
  if ([-3000, -3001, -3002, -3003, -3004, -3005, -3006].includes(code)) return true;
  const msg = String(data.message || "").toLowerCase();
  return /token|auth|unauthor|login/.test(msg);
}

async function callUsersAdd(payload, token) {
  const body = new URLSearchParams({
    token,
    store_department_id: STORE_DEPARTMENT_ID,
    user_phone: payload.user_phone,
    email: payload.email,
    first_name: payload.first_name,
    last_name: payload.last_name,
  });
  const r = await fetch(SAILPLAY_USERS_ADD_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch { data = { raw: text }; }
  return { httpStatus: r.status, ok: r.ok, data };
}

async function handleRegister(req, res) {
  if (!PIN_CODE || !STORE_DEPARTMENT_ID || !STORE_DEPARTMENT_KEY) {
    return sendJSON(res, 500, {
      status: "error",
      message: "Server is not configured (missing SAILPLAY_PIN_CODE / SAILPLAY_STORE_DEPARTMENT_ID / SAILPLAY_STORE_DEPARTMENT_KEY).",
    });
  }

  let body;
  try {
    const raw = await readBody(req);
    body = JSON.parse(raw || "{}");
  } catch {
    return sendJSON(res, 400, { status: "error", message: "Bad JSON payload." });
  }

  const first_name = (body.first_name || "").trim();
  const last_name = (body.last_name || "").trim();
  const email = (body.email || "").trim();
  const user_phone = normalizePhone(body.user_phone);

  if (first_name.length < 2) return sendJSON(res, 400, { status: "error", message: "Некорректное имя." });
  if (last_name.length < 2) return sendJSON(res, 400, { status: "error", message: "Некорректная фамилия." });
  if (!isValidEmail(email)) return sendJSON(res, 400, { status: "error", message: "Некорректный email." });
  if (!user_phone) return sendJSON(res, 400, { status: "error", message: "Некорректный телефон." });

  const payload = { first_name, last_name, email, user_phone };

  try {
    let token = await getToken();
    let result = await callUsersAdd(payload, token);

    // If SailPlay says token is bad, force-refresh once and retry.
    if (isTokenError(result.data, result.httpStatus)) {
      console.warn("[sailplay] token rejected, refreshing");
      token = await getToken({ force: true });
      result = await callUsersAdd(payload, token);
    }

    const isLogicalError = result.data && result.data.status === "error";
    const status = result.ok || isLogicalError ? 200 : 502;
    return sendJSON(res, status, result.data);
  } catch (err) {
    console.error("[sailplay] request failed:", err);
    return sendJSON(res, 502, {
      status: "error",
      message: "Не удалось связаться с SailPlay. Попробуйте позже.",
    });
  }
}

const server = http.createServer((req, res) => {
  if (req.method === "POST" && req.url === "/api/sailplay/register") {
    return handleRegister(req, res);
  }
  if (req.method === "GET") return serveStatic(req, res);
  res.writeHead(405); res.end("Method Not Allowed");
});

if (require.main === module) {
  server.listen(PORT, () => {
    console.log(`Registration page → http://localhost:${PORT}/register.html`);
  });
}

module.exports = { server, normalizePhone, isValidEmail, getToken };
