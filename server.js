// Minimal Node.js backend that proxies registration requests to SailPlay.
// No npm dependencies — uses only Node built-ins. Requires Node 18+.
//
// Setup:
//   1) Set env vars:
//        SAILPLAY_TOKEN=<your token from SailPlay dashboard>
//        SAILPLAY_STORE_DEPARTMENT_ID=<your store_department_id, e.g. 14864>
//      (Optionally) PORT=3000
//   2) node server.js
//   3) Open http://localhost:3000/register.html
//
// The SailPlay API token must NEVER live in the browser — keep it here, on the server.
// Docs: https://docs.retailrocket.net/docs/sailplay/clients/basics/

const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = Number(process.env.PORT) || 3000;
const TOKEN = process.env.SAILPLAY_TOKEN;
const STORE_DEPARTMENT_ID = process.env.SAILPLAY_STORE_DEPARTMENT_ID;
const SAILPLAY_URL = "https://api.sailplay.net/api/v2/users/add/";

if (!TOKEN || !STORE_DEPARTMENT_ID) {
  console.warn(
    "[WARN] SAILPLAY_TOKEN or SAILPLAY_STORE_DEPARTMENT_ID is not set. " +
    "The /api/sailplay/register endpoint will return 500 until both are configured."
  );
}

// --- helpers ---
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

function isValidEmail(s) {
  return typeof s === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
}

function normalizePhone(raw) {
  if (typeof raw !== "string") return null;
  let d = raw.replace(/\D/g, "");
  if (d.startsWith("8")) d = "7" + d.slice(1);
  // SailPlay expects international format without '+', e.g. 79998887766
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
  // Map / -> /register.html
  const url = req.url === "/" ? "/register.html" : req.url.split("?")[0];
  // Prevent path traversal
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

async function handleRegister(req, res) {
  if (!TOKEN || !STORE_DEPARTMENT_ID) {
    return sendJSON(res, 500, {
      status: "error",
      message: "Server is not configured (missing SAILPLAY_TOKEN / SAILPLAY_STORE_DEPARTMENT_ID).",
    });
  }

  let payload;
  try {
    const raw = await readBody(req);
    payload = JSON.parse(raw || "{}");
  } catch (e) {
    return sendJSON(res, 400, { status: "error", message: "Bad JSON payload." });
  }

  const { first_name, last_name, email, user_phone } = payload || {};

  if (!first_name || typeof first_name !== "string" || first_name.trim().length < 2)
    return sendJSON(res, 400, { status: "error", message: "Некорректное имя." });
  if (!last_name || typeof last_name !== "string" || last_name.trim().length < 2)
    return sendJSON(res, 400, { status: "error", message: "Некорректная фамилия." });
  if (!isValidEmail(email))
    return sendJSON(res, 400, { status: "error", message: "Некорректный email." });

  const phone = normalizePhone(user_phone);
  if (!phone)
    return sendJSON(res, 400, { status: "error", message: "Некорректный телефон." });

  const body = new URLSearchParams({
    token: TOKEN,
    store_department_id: STORE_DEPARTMENT_ID,
    user_phone: phone,
    email: email.trim(),
    first_name: first_name.trim(),
    last_name: last_name.trim(),
  });

  try {
    const sp = await fetch(SAILPLAY_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "application/json",
      },
      body,
    });
    const text = await sp.text();
    let data;
    try { data = JSON.parse(text); } catch { data = { raw: text }; }
    return sendJSON(res, sp.ok || data.status === "error" ? 200 : 502, data);
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

module.exports = { server, normalizePhone, isValidEmail };
