import "dotenv/config";
import express from "express";
import fs from "fs";

const {
  PORT = 3000,
  HOST = "127.0.0.1", // hanya bisa diakses dari STB sendiri; ganti 0.0.0.0 kalau web lo di mesin lain
  VIKEY_ACCESS,
  VIKEY_REFRESH,
  VIKEY_REFRESH_URL = "https://app.vikey.ai/api/auth/refresh",
  VIKEY_BALANCE_URL,
  VIKEY_LOGIN_URL, // opsional: auto-login kalau refresh token mati
  VIKEY_EMAIL,
  VIKEY_PASSWORD,
  MY_API_KEY, // kunci buat web lo manggil /balance
  ALLOWED_ORIGIN = "*",
} = process.env;

if (!VIKEY_REFRESH && !fs.existsSync("./tokens.json")) {
  console.error("VIKEY_REFRESH belum diisi di .env");
  process.exit(1);
}
if (!VIKEY_BALANCE_URL) {
  console.error("VIKEY_BALANCE_URL belum diisi di .env");
  process.exit(1);
}

const TOKEN_FILE = "./tokens.json";
const UA =
  "Mozilla/5.0 (Linux; Android 16; Pixel 10) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Mobile Safari/537.36";
const baseHeaders = {
  "Content-Type": "application/json",
  Accept: "application/json, text/plain, */*",
  Origin: "https://vikey.ai",
  Referer: "https://vikey.ai/",
  "User-Agent": UA,
};

// ---------- token store ----------
let access = VIKEY_ACCESS || "";
let refresh = VIKEY_REFRESH || "";

// pakai tokens.json hanya kalau seed-nya sama dengan VIKEY_REFRESH di .env.
// Kalau lo ganti token di .env, file lama otomatis diabaikan.
if (fs.existsSync(TOKEN_FILE)) {
  try {
    const f = JSON.parse(fs.readFileSync(TOKEN_FILE, "utf8"));
    if (!VIKEY_REFRESH || f.seed === VIKEY_REFRESH) {
      access = f.access || access;
      refresh = f.refresh || refresh;
    }
  } catch {}
}

function saveTokens() {
  fs.writeFileSync(
    TOKEN_FILE,
    JSON.stringify({ access, refresh, seed: VIKEY_REFRESH || "" }, null, 2)
  );
}

// baca exp (ms) dari JWT, null kalau tidak bisa dibaca
function expOf(jwt) {
  try {
    const p = JSON.parse(Buffer.from(jwt.split(".")[1], "base64url"));
    return p.exp ? p.exp * 1000 : null;
  } catch {
    return null;
  }
}

// ambil token dari berbagai kemungkinan bentuk response
function pickTokens(d) {
  const src = d?.data ?? d ?? {};
  return {
    a: src.accessToken ?? src.access_token ?? src.token,
    r: src.refreshToken ?? src.refresh_token,
  };
}

// ---------- refresh / login ----------
let refreshing = null; // lock: cegah refresh dobel (penting kalau token dirotasi)

async function doRefresh() {
  const r = await fetch(VIKEY_REFRESH_URL, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({ refreshToken: refresh }),
  });
  if (!r.ok) throw new Error(`refresh gagal: ${r.status} ${await r.text()}`);
  const { a, r: newRefresh } = pickTokens(await r.json());
  if (!a) throw new Error("response refresh tidak ada accessToken");
  access = a;
  refresh = newRefresh ?? refresh; // kalau dirotasi, pakai yang baru
  saveTokens();
  console.log("[token] refresh ok");
}

async function doLogin() {
  if (!VIKEY_LOGIN_URL || !VIKEY_EMAIL || !VIKEY_PASSWORD)
    throw new Error("auto-login tidak dikonfigurasi");
  const r = await fetch(VIKEY_LOGIN_URL, {
    method: "POST",
    headers: baseHeaders,
    body: JSON.stringify({ email: VIKEY_EMAIL, password: VIKEY_PASSWORD }), // sesuaikan field
  });
  if (!r.ok) throw new Error(`login gagal: ${r.status} ${await r.text()}`);
  const { a, r: newRefresh } = pickTokens(await r.json());
  if (!a || !newRefresh) throw new Error("response login tidak ada token");
  access = a;
  refresh = newRefresh;
  saveTokens();
  console.log("[token] login ulang ok");
}

function renewTokens() {
  if (refreshing) return refreshing;
  refreshing = doRefresh()
    .catch(async (e) => {
      console.error("[token]", e.message);
      await doLogin(); // fallback; kalau ini juga gagal, error naik ke atas
    })
    .finally(() => {
      refreshing = null;
    });
  return refreshing;
}

// cek tiap 10 detik, refresh hanya kalau sisa umur access token < 60 detik
setInterval(async () => {
  const exp = expOf(access);
  if (exp === null) return; // bukan JWT / tidak ada exp: andalkan retry saat 401
  if (exp - Date.now() < 60_000) {
    try {
      await renewTokens();
    } catch (e) {
      console.error("[loop]", e.message);
    }
  }
}, 10_000);

// ---------- ambil balance ----------
let cache = { at: 0, data: null };

async function getBalance(retry = true) {
  const r = await fetch(VIKEY_BALANCE_URL, {
    headers: { ...baseHeaders, Authorization: `Bearer ${access}` },
  });
  if (r.status === 401 && retry) {
    await renewTokens();
    return getBalance(false);
  }
  if (!r.ok) throw new Error(`balance gagal: ${r.status}`);
  return r.json();
}

// ---------- REST API ----------
const app = express();

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", ALLOWED_ORIGIN);
  res.setHeader("Access-Control-Allow-Headers", "x-api-key, content-type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.get("/balance", async (req, res) => {
  if (MY_API_KEY && req.get("x-api-key") !== MY_API_KEY)
    return res.status(401).json({ error: "unauthorized" });
  try {
    if (Date.now() - cache.at > 5_000) {
      cache = { at: Date.now(), data: await getBalance() };
    }
    res.json(cache.data);
  } catch (e) {
    console.error("[balance]", e.message);
    res.status(502).json({ error: e.message });
  }
});

app.listen(PORT, HOST, () => console.log(`vikey-proxy jalan di ${HOST}:${PORT}`));
