import fs from "node:fs";
import path from "node:path";
import puppeteer from "puppeteer-extra";
import StealthPlugin from "puppeteer-extra-plugin-stealth";

puppeteer.use(StealthPlugin());

const API_BASE = "https://api.holodori.best/api/events";
const DATA_DIR = path.resolve("data");
const GRAPHS_DIR = path.join(DATA_DIR, "graphs");
const RANKS = [100, 500, 1000, 5000, 10000, 50000, 100000];

fs.mkdirSync(GRAPHS_DIR, { recursive: true });

function isTargetEvent(ev) {
  if (!ev || !ev.hasData) return false;
  const name = ev.name || "";
  if (ev.type === 2 || name.includes("スポットライト")) return true;
  if ((ev.type === 1 && ev.isSongScore === false) || name.includes("ポイント")) return true;
  return false;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ブラウザページ内のコンテキストからAPIを取得（CloudflareのCookie・TLS指紋をそのまま利用）
async function fetchJsonInBrowser(page, url) {
  const result = await page.evaluate(async (targetUrl) => {
    try {
      const res = await fetch(targetUrl, {
        headers: { "Accept": "application/json, text/plain, */*" }
      });
      const text = await res.text();
      return { ok: res.ok, status: res.status, text };
    } catch (e) {
      return { ok: false, status: 0, text: String(e) };
    }
  }, url);

  if (!result.ok) {
    throw new Error(`HTTP ${result.status} for ${url}`);
  }
  if (result.text.trim().startsWith("<")) {
    throw new Error(`HTML challenge returned for ${url}`);
  }
  return JSON.parse(result.text);
}

async function main() {
  console.log("Launching stealth browser...");
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // 先にフロントページを開き、Cloudflareのセキュリティ検証とCookieを通過させる
    console.log("Warming up session on holodori.best...");
    await page.goto("https://holodori.best/", {
      waitUntil: "networkidle2",
      timeout: 60000
    });
    await sleep(4000);

    console.log("Fetching event list...");
    const listData = await fetchJsonInBrowser(page, `${API_BASE}/list?region=jp&language=jpn`);
    const events = listData.events || [];
    fs.writeFileSync(path.join(DATA_DIR, "events.json"), JSON.stringify(listData));

    const now = Date.now();
    const targetEvents = events.filter(isTargetEvent);
    console.log(`Found ${targetEvents.length} target events (spotlight / point).`);

    const manifest = {
      updatedAt: now,
      ranks: RANKS,
      items: []
    };

    for (const ev of targetEvents) {
      const chapters = Array.isArray(ev.chapters) && ev.chapters.length > 0
        ? ev.chapters
        : Object.keys(ev.chapterMeta || {});

      for (const cid of chapters) {
        const cm = (ev.chapterMeta && ev.chapterMeta[cid]) || {};
        const st = cm.startTime || ev.startTime;
        const et = cm.endTime || ev.endTime;
        if (!st || !et) continue;

        const isChapterLive = Boolean(ev.live && (ev.activeChapterId === cid || (now >= st && now <= et)));
        const isStarted = st <= now || !ev.live;
        if (!isStarted && !isChapterLive) continue;

        const safeId = `${ev.eventId}__${cid}`.replace(/[^a-zA-Z0-9_-]/g, "_");
        manifest.items.push({
          eventId: ev.eventId,
          chapterId: cid,
          safeId,
          live: isChapterLive
        });

        for (const rank of RANKS) {
          const fileName = `${safeId}__r${rank}.json`;
          const filePath = path.join(GRAPHS_DIR, fileName);

          // 完了済みチャプターは既存キャッシュを再利用
          if (!isChapterLive && fs.existsSync(filePath)) {
            try {
              const existing = JSON.parse(fs.readFileSync(filePath, "utf-8"));
              if (Array.isArray(existing.tier) && existing.tier.length >= 20) {
                const lastTs = existing.tier[existing.tier.length - 1][0];
                if (lastTs >= et - 15 * 60 * 1000) {
                  continue;
                }
              }
            } catch (_) {}
          }

          const url = `${API_BASE}/graph?region=jp&rank=${rank}&border=true&music=false&event_id=${encodeURIComponent(ev.eventId)}&chapter_id=${encodeURIComponent(cid)}`;
          try {
            const graph = await fetchJsonInBrowser(page, url);
            if (graph && Array.isArray(graph.tier) && graph.tier.length > 0) {
              fs.writeFileSync(filePath, JSON.stringify(graph));
              console.log(`Saved ${fileName} (${graph.tier.length} pts)`);
            }
          } catch (err) {
            console.warn(`Skipped ${fileName}: ${err.message}`);
          }
          await sleep(400);
        }
      }
    }

    fs.writeFileSync(path.join(DATA_DIR, "manifest.json"), JSON.stringify(manifest));
    console.log("Done.");
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
