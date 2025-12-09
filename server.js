// server.js
// Tiny backend that merges Zamarank search + S5 leaderboards into 1 clean JSON

const{ createCanvas, loadImage } = require("@napi-rs/canvas");
const express = require("express");
const fetch = require("node-fetch");

const app = express();
const PORT = process.env.PORT || 3000;

// --- Helpers ----------------------------------------------------

// Fetch URL and parse JSON
async function fetchJson(url) {
  const res = await fetch(url);
  const text = await res.text();

  // Try to parse JSON; if it fails, throw a readable error
  try {
    return JSON.parse(text);
  } catch (e) {
    throw new Error(`invalid JSON at ${url} -> ${text.slice(0, 120)}...`);
  }
}

// Find a user row inside a leaderboard list
function findUserRow(list, handle) {
  if (!Array.isArray(list)) return null;

  const target1 = "@" + handle.toLowerCase();
  const target2 = handle.toLowerCase();

  return (
    list.find((row) => {
      if (!row) return false;
      const h =
        (row.handle || row.username || row.twitter || "").toLowerCase();
      return h === target1 || h === target2;
    }) || null
  );
}

// Loop pages 1..maxPages for a timeframe until we find the user
async function findUserInTimeframe(baseUrl, handle, maxPages = 15) {
  for (let page = 1; page <= maxPages; page++) {
    const url = `${baseUrl}${page}`;
    const data = await fetchJson(url);

    // DEBUG: show structure of the first page we load
    if (page === 1) {
      console.log("=== DEBUG timeframe page 1 ===");
      console.log("URL:", url);
      console.log("Top-level keys:", Object.keys(data));
      // print first 1–2 entries if it’s an array or has a list
      if (Array.isArray(data)) {
        console.log("First entry:", data[0]);
      } else if (Array.isArray(data.items)) {
        console.log("First entry (items[0]):", data.items[0]);
      } else if (Array.isArray(data.leaderboard)) {
        console.log("First entry (leaderboard[0]):", data.leaderboard[0]);
      } else {
        console.log("Data sample:", data);
      }
    }

    let list;
    if (Array.isArray(data)) {
      list = data;
    } else if (Array.isArray(data.data)) {
      // <- THIS is the real leaderboard array
      list = data.data;
    } else {
      list = [];
    }

    if (!list.length) break;

    const row = findUserRow(list, handle);
    if (row) return row;
  }
  return null;
}

// --- Routes -----------------------------------------------------

// Simple root route (for sanity check)
app.get("/", (req, res) => {
  res.send("Zama helper API is running. Try /zama/<handle>");
});

// Main API: /zama/:handle
app.get("/zama/:handle", async (req, res) => {
  const raw = req.params.handle.toLowerCase();
  const handle = raw.startsWith("@") ? raw.slice(1) : raw;

  const searchUrl = `https://zamarank.live/api/search/${handle}`;

  // use the SAME base24/base7/base30 URLs that already work for you
  const base24 =
    "https://leaderboard-bice-mu.vercel.app/api/zama?timeframe=24h&sortBy=mindshare&page=";
  const base7 =
    "https://leaderboard-bice-mu.vercel.app/api/zama?timeframe=7d&sortBy=mindshare&page=";
  const base30 =
    "https://leaderboard-bice-mu.vercel.app/api/zama?timeframe=30d&sortBy=mindshare&page=";

  try {
    const searchData = await fetchJson(searchUrl);

    // seasons S1–S4 from search
    const seasons = { s1: null, s2: null, s3: null, s4: null };
    if (Array.isArray(searchData.results)) {
      for (const r of searchData.results) {
        if (!r || !r.season) continue;
        const key = r.season.toLowerCase();
        if (key in seasons) seasons[key] = r.rank ?? null;
      }
    }

    const resultsArr = Array.isArray(searchData.results)
      ? searchData.results
      : [];
    const allSeasonRanksNull = resultsArr.every(
      (r) => !r || r.rank == null
    );
    const s5Found = searchData.s5 && searchData.s5.found === true;

    // 🔴 EARLY EXIT: not ranked anywhere, don't scan S5 pages
    if (allSeasonRanksNull && !s5Found) {
      return res.json({
        handle: searchData.handle || "@" + handle,
        displayName: searchData.displayName || handle,
        avatar: searchData.profilePic || null,
        seasons,
        s5: {
          rank24h: null,
          rank7d: null,
          rank30d: null,
          mindshare24h: null,
          mindshare7d: null,
          mindshare30d: null,
        },
        status: "not_ranked",
      });
    }

    // 🟡 Otherwise: user exists → fetch S5 leaderboards (24h/7d/30d)
    const [row24, row7, row30] = await Promise.all([
      findUserInTimeframe(base24, handle),
      findUserInTimeframe(base7, handle),
      findUserInTimeframe(base30, handle),
    ]);

    const response = {
      handle: searchData.handle || "@" + handle,
      displayName: searchData.displayName || handle,
      avatar: searchData.profilePic || null,
      seasons,
      s5: {
        rank24h: row24 ? row24.rank ?? null : null,
        rank7d: row7 ? row7.rank ?? null : null,
        rank30d: row30 ? row30.rank ?? null : null,
        mindshare24h: row24 ? row24.mindshare ?? null : null,
        mindshare7d: row7 ? row7.mindshare ?? null : null,
        mindshare30d: row30 ? row30.mindshare ?? null : null,
      },
      status: "ok",
    };

    res.json(response);
  } catch (err) {
    console.error(err);
    res
      .status(500)
      .json({ error: "server_error", message: err.message });
  }
});

// -----------------------------------------
// Keep Render awake by pinging itself
// -----------------------------------------
setInterval(() => {
  fetch("https://zamarank-bot.onrender.com/")
    .then(() => console.log("Self-ping OK"))
    .catch(() => console.log("Self-ping failed"));
}, 30000); // every 0.5 mins



// DYNAMIC RANK CARD USING CANVA BACKGROUND
app.get("/card/:handle", async (req, res) => {
  try {
    const raw = req.params.handle.toLowerCase();
    const handle = raw.startsWith("@") ? raw.slice(1) : raw;

    // 1) Get combined Zama data from your own API
    const data = await fetchJson(
      "https://zamarank-bot.onrender.com/zama/" + handle
    );

    // 2) Load your Canva background (page 4, no zeros)
    const BG_URL =
      "https://cdn.discordapp.com/attachments/1385567455220334622/1447921742810058895/24h.png?ex=693961b4&is=69381034&hm=c2b432ab13d3372a47bcc915200fe55f42837718228903bf7de3a2efeb9b0442"; // TODO: paste your real link here

    const bg = await loadImage(BG_URL);
    const canvas = createCanvas(bg.width, bg.height);
    const ctx = canvas.getContext("2d");

    // Draw background exactly
    ctx.drawImage(bg, 0, 0, bg.width, bg.height);

    // -------- Avatar exactly in the circle --------
    try {
      const avatarUrl = data.avatar || "https://unavatar.io/twitter/zama_fhe";
      const avatar = await loadImage(avatarUrl);

      // These numbers assume 1200x600 canvas.
      // Adjust slightly if needed until the face sits perfectly inside the ring.
      const avatarSize = 260; // circle size
      const avatarX = 125; // left offset
      const avatarY = -55; // top offset

      ctx.save();
      ctx.beginPath();
      ctx.arc(
        avatarX + avatarSize / 2,
        avatarY + avatarSize / 2,
        avatarSize / 2,
        0,
        Math.PI * 2
      );
      ctx.closePath();
      ctx.clip();
      ctx.drawImage(avatar, avatarX, avatarY, avatarSize, avatarSize);
      ctx.restore();
    } catch (e) {
      console.error("Avatar load failed", e);
    }

    // -------- Helper formatters --------
    function fmtRank(v) {
      return v == null ? "Not ranked" : "#" + v;
    }
    function fmtPct(v) {
      if (v == null) return "Not ranked";
      return v.toFixed(6) + "%";
    }

    const r24 = data.s5?.rank24h ?? null;
    const r7 = data.s5?.rank7d ?? null;
    const r30 = data.s5?.rank30d ?? null;
    const m24 = data.s5?.mindshare24h ?? null;
    const m7 = data.s5?.mindshare7d ?? null;
    const m30 = data.s5?.mindshare30d ?? null;

    // text color
    ctx.fillStyle = "#000000";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";

    // ---------- CONFIG YOU CAN TWEAK ----------
    const rankX = 545; // all RANK numbers use this X
    const msX = 1000; // all MINDSHARE numbers use this X

    const baseY = 390; // Y for the 24H row
    const rowGap = 178; // vertical gap between rows (24H → 7D → 30D)

    // fonts
    const rankFont = "bold 95px Impact, 'Arial Black',Sans-serif";
    const msFont = "bold 90px Impact, 'Arial Black',Sans-serif";
    // ------------------------------------------

    // helper: draw outlined text (white border + black fill)
function drawOutlinedText(text, x, y, font) {
  ctx.font = font;
  ctx.lineWidth = 8;
  ctx.strokeStyle = "#ffffff"; // outline color
  ctx.fillStyle = "#000000";   // fill color
  ctx.strokeText(text, x, y);
  ctx.fillText(text, x, y);
}

// RANK column
drawOutlinedText(fmtRank(r24), rankX, baseY, rankFont);
drawOutlinedText(fmtRank(r7),  rankX, baseY + rowGap, rankFont);
drawOutlinedText(fmtRank(r30), rankX, baseY + 2 * rowGap, rankFont);

// MINDSHARE column
drawOutlinedText(fmtPct(m24), msX, baseY, msFont);
drawOutlinedText(fmtPct(m7),  msX, baseY + rowGap, msFont);
drawOutlinedText(fmtPct(m30), msX, baseY + 2 * rowGap, msFont);

    // Optional tiny footer text on the card
    ctx.font = "26px Sans-serif";
    ctx.fillText("Made with love by @aliorbz", 40, bg.height - 40);

    // Send PNG
    const buffer = canvas.toBuffer("image/png");
    res.set("Content-Type", "image/png");
    res.send(buffer);
  } catch (err) {
    console.error("Card error", err);
    res.status(500).json({ error: "card_error", message: err.message });
  }
});



// --- Start server -----------------------------------------------

app.listen(PORT, () => {
  console.log(`Zama helper API running on http://localhost:${PORT}`);
});