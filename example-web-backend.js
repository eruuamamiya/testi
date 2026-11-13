// CONTOH: route di backend WEB LO (bukan bagian dari proxy).
// Tujuan: tampilkan saldo Vikey hanya untuk akun admin.
//
// .env web lo:
//   VIKEY_PROXY_URL=http://127.0.0.1:3000
//   VIKEY_PROXY_KEY=isi_sama_persis_dengan_MY_API_KEY_di_proxy
//
// Sesuaikan requireAuth dan req.user.role dengan sistem login lo.

import express from "express";
const app = express();

app.get("/api/admin/vikey-balance", requireAuth, async (req, res) => {
  if (req.user.role !== "admin") {
    return res.status(403).json({ error: "forbidden" });
  }
  try {
    const r = await fetch(`${process.env.VIKEY_PROXY_URL}/balance`, {
      headers: { "x-api-key": process.env.VIKEY_PROXY_KEY },
    });
    if (!r.ok) throw new Error("proxy " + r.status);
    res.json(await r.json());
  } catch (e) {
    console.error(e.message);
    res.status(502).json({ error: "gagal ambil saldo Vikey" });
  }
});

// ---- contoh frontend (jalan di browser, hanya render kalau user admin) ----
// const r = await fetch("/api/admin/vikey-balance");
// const data = await r.json();
// document.querySelector("#saldo").textContent = JSON.stringify(data);
// (ganti dengan field saldo yang sebenarnya setelah lo lihat bentuk JSON-nya)
