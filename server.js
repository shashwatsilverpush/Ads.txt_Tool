const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const multer = require('multer');
const { parse } = require('csv-parse/sync');
const pLimit = require('p-limit');
const XLSX = require('xlsx');
const pdfParse = require('pdf-parse');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static('public', {
  setHeaders: (res, path) => {
    if (path.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    }
  }
}));

const HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Accept-Language': 'en-US,en;q=0.9',
  'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
};

function normalizeDomain(url) {
  try {
    const u = new URL(url.startsWith('http') ? url : 'https://' + url);
    return `${u.protocol}//${u.hostname}`;
  } catch {
    return null;
  }
}

async function getDeveloperUrlAndroid(bundleId) {
  const playUrl = `https://play.google.com/store/apps/details?id=${bundleId}&hl=en`;
  try {
    const { data } = await axios.get(playUrl, { headers: HEADERS, timeout: 10000 });

    let devUrl = null;

    // First: look for explicit developer_url field in embedded JS data
    const devUrlFieldMatch = data.match(/developer_url[^"']*["'](https?:\/\/[^"']{3,200})["']/i);
    if (devUrlFieldMatch) {
      devUrl = devUrlFieldMatch[1];
    }

    // Second: general URL scan as fallback
    if (!devUrl) {
      const urlMatches = data.match(/"(https?:\/\/(?!play\.google|support\.google|policies\.google|console\.firebase|goo\.gl|g\.co)[^"]{5,200})"/g);
      if (urlMatches) {
        for (const m of urlMatches) {
          const url = m.replace(/"/g, '');
          if (url.match(/\.(jpg|jpeg|png|gif|svg|ico|css|js|mp4|webp)(\?|$)/i)) continue;
          if (url.includes('googleapis') || url.includes('ggpht') || url.includes('android.com') ||
              url.includes('gstatic.com') || url.includes('googleusercontent.com') ||
              url.includes('googlesyndication.com') || url.includes('doubleclick.net')) continue;
          // Skip deep CDN/asset paths (more than 3 path segments usually means a resource, not a site)
          try { const u = new URL(url); if (u.pathname.split('/').filter(Boolean).length > 3) continue; } catch {}
          if (url.match(/https?:\/\/[a-z0-9.-]+\.[a-z]{2,}/i) && !url.includes('google')) {
            devUrl = url;
            break;
          }
        }
      }
    }

    return { storeUrl: playUrl, developerUrl: devUrl, platform: 'android', appFound: true };
  } catch (err) {
    const appFound = err.response?.status !== 404;
    return { storeUrl: playUrl, developerUrl: null, platform: 'android', appFound, error: err.response?.status === 404 ? 'Not found on Google Play' : err.message };
  }
}

async function getDeveloperUrlFromAppStorePage(appId) {
  try {
    const storeUrl = `https://apps.apple.com/us/app/id${appId}`;
    const { data } = await axios.get(storeUrl, { headers: HEADERS, timeout: 10000 });
    // Try JSON-LD structured data first
    const ldRegex = /<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi;
    let ldMatch;
    while ((ldMatch = ldRegex.exec(data)) !== null) {
      try {
        const ld = JSON.parse(ldMatch[1]);
        const candidates = [
          ld?.url, ld?.sameAs,
          ld?.author?.url, ld?.creator?.url, ld?.publisher?.url,
        ].flat().filter(Boolean);
        for (const u of candidates) {
          if (u && !u.includes('apple.com') && u.startsWith('http')) return u;
        }
      } catch {}
    }
    // Fallback: look for siteUrl or website fields in embedded JSON
    const siteMatch = data.match(/"siteUrl"\s*:\s*"(https?:\/\/(?!.*apple\.com)[^"]+)"/i)
                   || data.match(/"website"\s*:\s*"(https?:\/\/(?!.*apple\.com)[^"]+)"/i);
    if (siteMatch) return siteMatch[1];
  } catch {}
  return null;
}

async function getDeveloperUrlIOS(bundleId) {
  const appId = bundleId.replace(/^id/i, '');
  const lookupUrl = `https://itunes.apple.com/lookup?id=${appId}&country=us`;
  try {
    const { data } = await axios.get(lookupUrl, { headers: HEADERS, timeout: 10000 });
    if (!data.results || data.results.length === 0) {
      return { storeUrl: lookupUrl, developerUrl: null, platform: 'ios', appFound: false, error: 'Not found on App Store' };
    }
    const app = data.results[0];
    let developerUrl = app.sellerUrl || null;
    if (!developerUrl) developerUrl = await getDeveloperUrlFromAppStorePage(appId);
    return {
      storeUrl: app.trackViewUrl || `https://apps.apple.com/app/id${appId}`,
      developerUrl,
      platform: 'ios', appFound: true,
      appName: app.trackName, developerName: app.artistName,
    };
  } catch (err) {
    return { storeUrl: lookupUrl, developerUrl: null, platform: 'ios', appFound: false, error: err.message };
  }
}

async function getDeveloperUrlByBundleName(bundleId) {
  const lookupUrl = `https://itunes.apple.com/lookup?bundleId=${bundleId}&country=us`;
  try {
    const { data } = await axios.get(lookupUrl, { headers: HEADERS, timeout: 10000 });
    if (data.results && data.results.length > 0) {
      const app = data.results[0];
      let developerUrl = app.sellerUrl || null;
      if (!developerUrl && app.trackId) developerUrl = await getDeveloperUrlFromAppStorePage(app.trackId);
      return {
        storeUrl: app.trackViewUrl || lookupUrl,
        developerUrl,
        platform: 'ios', appFound: true,
        appName: app.trackName, developerName: app.artistName,
      };
    }
  } catch {}
  return null;
}

// Token search: all space/+ separated tokens must appear on the same line
function matchTokens(lines, kw) {
  const tokens = kw.toLowerCase().trim().split(/[\s+]+/).filter(Boolean);
  const exactLines = lines.filter(l => {
    const lLower = l.toLowerCase();
    return tokens.every(t => lLower.includes(t));
  });
  return { exactLines, partialLines: [] };
}

// Ads.txt line format: field-by-field comparison (comma-separated)
// Exact   = same field count, all fields match (case-insensitive)
// Partial = domain matches + at least one other field matches, but not all
function matchAdsTxtLine(lines, kw) {
  const kwFields = kw.split(',').map(f => f.trim().toLowerCase());
  const exactLines = [];
  const partialLines = [];
  for (const line of lines) {
    const l = line.trim();
    if (!l || l.startsWith('#')) continue;
    const lf = l.split(',').map(f => f.trim().toLowerCase());
    if (kwFields.length === lf.length && kwFields.every((f, i) => lf[i] === f)) {
      exactLines.push(line);
    } else if (kwFields[0] && lf[0] === kwFields[0]) {
      const otherMatch = kwFields.slice(1).some((f, i) => f !== '' && lf[i + 1] !== undefined && lf[i + 1] === f);
      if (otherMatch) partialLines.push(line);
    }
  }
  return { exactLines, partialLines };
}

// Multi-line block: each kw line matched independently
// Block exact   = ALL kw lines have exact matches
// Block partial = some kw lines found (exact or partial), but not all exact
function matchBlock(lines, kwBlock) {
  const kwLines = kwBlock.split('\n').map(l => l.trim()).filter(l => l && !l.startsWith('#'));
  let exactCount = 0;
  const allExact = [];
  const allPartial = [];
  const missingKwLines = [];
  for (const kwLine of kwLines) {
    const { exactLines, partialLines } = kwLine.includes(',')
      ? matchAdsTxtLine(lines, kwLine)
      : matchTokens(lines, kwLine);
    if (exactLines.length > 0) { exactCount++; allExact.push(...exactLines); }
    else if (partialLines.length > 0) { allPartial.push(...partialLines); }
    else { missingKwLines.push(kwLine); }
  }
  if (kwLines.length === 0) return { exactLines: [], partialLines: [], missingLines: [] };
  if (exactCount === kwLines.length) return { exactLines: allExact, partialLines: [], missingLines: [] };
  if (allExact.length > 0 || allPartial.length > 0) return { exactLines: allExact, partialLines: allPartial, missingLines: missingKwLines };
  return { exactLines: [], partialLines: [], missingLines: missingKwLines };
}

function matchKeyword(lines, kw) {
  const kwTrimmed = kw.trim();
  if (kwTrimmed.includes('\n')) return matchBlock(lines, kwTrimmed);
  if (kwTrimmed.includes(','))  return matchAdsTxtLine(lines, kwTrimmed);
  return matchTokens(lines, kwTrimmed);
}

function buildKeywordResults(lines, keywords) {
  const matches = {};
  const partialMatches = {};
  const missingLines = {};
  for (const kw of keywords) {
    if (!kw.trim()) continue;
    const { exactLines, partialLines, missingLines: ml } = matchKeyword(lines, kw);
    matches[kw] = exactLines;
    partialMatches[kw] = partialLines;
    missingLines[kw] = ml || [];
  }
  return { matches, partialMatches, missingLines };
}

async function fetchDirectUrl(url, keywords) {
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 8000, maxRedirects: 5 });
    const lines = data.split('\n').map(l => l.trim()).filter(Boolean);
    const { matches, partialMatches, missingLines } = buildKeywordResults(lines, keywords);
    return { url, found: true, totalLines: lines.length, matches, partialMatches, missingLines };
  } catch (err) {
    const msg = err.response?.status === 404 ? 'Not found (404)' : err.message;
    return { url, found: false, error: msg, matches: {}, partialMatches: {}, missingLines: {} };
  }
}

async function fetchAdsTxt(inputUrl, keywords) {
  const domain = normalizeDomain(inputUrl);
  if (!domain) return { url: null, found: false, error: 'Invalid URL', matches: {}, partialMatches: {}, missingLines: {} };
  const adsUrl = `${domain}/ads.txt`;
  try {
    const { data } = await axios.get(adsUrl, { headers: HEADERS, timeout: 8000, maxRedirects: 5 });
    const lines = data.split('\n').map(l => l.trim()).filter(Boolean);
    const { matches, partialMatches, missingLines } = buildKeywordResults(lines, keywords);
    return { url: adsUrl, found: true, totalLines: lines.length, matches, partialMatches, missingLines };
  } catch (err) {
    const msg = err.response?.status === 404 ? 'ads.txt not found (404)' : err.message;
    return { url: adsUrl, found: false, error: msg, matches: {}, partialMatches: {}, missingLines: {} };
  }
}

async function fetchAppAdsTxt(developerUrl, keywords) {
  const domain = normalizeDomain(developerUrl);
  if (!domain) return { url: null, found: false, error: 'Invalid developer URL', matches: {}, partialMatches: {}, missingLines: {} };
  const adsUrl = `${domain}/app-ads.txt`;
  try {
    const { data } = await axios.get(adsUrl, { headers: HEADERS, timeout: 8000, maxRedirects: 5 });
    const lines = data.split('\n').map(l => l.trim()).filter(Boolean);
    const { matches, partialMatches, missingLines } = buildKeywordResults(lines, keywords);
    return { url: adsUrl, found: true, totalLines: lines.length, matches, partialMatches, missingLines };
  } catch (err) {
    const msg = err.response?.status === 404 ? 'app-ads.txt not found (404)' : err.message;
    return { url: adsUrl, found: false, error: msg, matches: {}, partialMatches: {}, missingLines: {} };
  }
}

function isAmazonASIN(id) {
  return /^B[A-Z0-9]{9}$/.test(id);
}

async function getDeveloperUrlAmazon(asin) {
  const storeUrl = `https://www.amazon.com/dp/${asin}`;
  try {
    const { data } = await axios.get(storeUrl, { headers: HEADERS, timeout: 10000 });
    let devUrl = null;
    let appName = null;
    let developerName = null;

    // developer_url field in page source
    const devUrlMatch = data.match(/developer[_-]url[^"']*["'](https?:\/\/[^"']{3,200})["']/i);
    if (devUrlMatch) devUrl = devUrlMatch[1];

    // developerWebsite in embedded JSON
    if (!devUrl) {
      const wsMatch = data.match(/"developerWebsite"\s*:\s*"(https?:\/\/[^"]+)"/i)
                   || data.match(/"website"\s*:\s*"(https?:\/\/(?!.*amazon\.)[^"]+)"/i);
      if (wsMatch) devUrl = wsMatch[1];
    }

    // External href links not pointing to Amazon domains
    if (!devUrl) {
      const urlMatches = data.match(/href="(https?:\/\/(?!(?:www\.|m\.)?amazon\.|amzn\.|kindle\.|m\.media-amazon\.)[^"]{5,200})"/g) || [];
      for (const m of urlMatches) {
        const url = m.replace(/^href="/, '').replace(/"$/, '');
        if (url.match(/\.(jpg|jpeg|png|gif|svg|ico|css|js|mp4|webp)(\?|$)/i)) continue;
        if (url.includes('amazonaws') || url.includes('images-amazon')) continue;
        try { const u = new URL(url); if (u.pathname.split('/').filter(Boolean).length > 3) continue; } catch { continue; }
        devUrl = url;
        break;
      }
    }

    // App name
    const titleMatch = data.match(/id="productTitle"[^>]*>\s*([\s\S]*?)\s*<\/span>/);
    if (titleMatch) appName = titleMatch[1].replace(/<[^>]+>/g, '').trim();

    // Developer name
    const devNameMatch = data.match(/by\s+<a[^>]+>([^<]{2,80})<\/a>/i)
                      || data.match(/Brand[^<]*<[^>]+>\s*<a[^>]+>([^<]{2,80})<\/a>/i);
    if (devNameMatch) developerName = devNameMatch[1].trim();

    return { storeUrl, developerUrl: devUrl, platform: 'amazon', appFound: true, appName, developerName };
  } catch (err) {
    const appFound = err.response?.status !== 404;
    return { storeUrl, developerUrl: null, platform: 'amazon', appFound,
             error: err.response?.status === 404 ? 'Not found on Amazon' : err.message };
  }
}

async function crawlBundle(bundleId, keywords, platform) {
  const result = { bundleId, keywords, android: null, ios: null, amazon: null, adsTxt: null };
  let developerUrl = null;
  let appMeta = {};

  const isNumericId = /^\d+$/.test(bundleId.replace(/^id/i, ''));
  const isAmazonId = isAmazonASIN(bundleId);

  // Amazon
  if (platform === 'amazon' || (platform === 'both' && isAmazonId)) {
    const amazonResult = await getDeveloperUrlAmazon(bundleId);
    result.amazon = amazonResult;
    if (amazonResult.developerUrl) {
      developerUrl = amazonResult.developerUrl;
      appMeta = { platform: 'amazon', appName: amazonResult.appName, developerName: amazonResult.developerName };
    }
  }

  // iOS numeric
  if (!developerUrl && (platform === 'ios' || (platform === 'both' && isNumericId && !isAmazonId))) {
    const iosResult = await getDeveloperUrlIOS(bundleId);
    result.ios = iosResult;
    if (iosResult.developerUrl) {
      developerUrl = iosResult.developerUrl;
      appMeta = { platform: 'ios', appName: iosResult.appName, developerName: iosResult.developerName };
    }
  }

  // 'both' mode + non-numeric + non-Amazon: run Android and iOS bundle lookup IN PARALLEL
  if (!developerUrl && platform === 'both' && !isNumericId && !isAmazonId) {
    const [androidResult, iosBundleResult] = await Promise.all([
      getDeveloperUrlAndroid(bundleId),
      getDeveloperUrlByBundleName(bundleId),
    ]);
    result.android = androidResult;
    if (androidResult.developerUrl) {
      developerUrl = androidResult.developerUrl;
      appMeta = { platform: 'android' };
    }
    if (!developerUrl && iosBundleResult) {
      result.ios = iosBundleResult;
      if (iosBundleResult.developerUrl) {
        developerUrl = iosBundleResult.developerUrl;
        appMeta = { platform: 'ios', appName: iosBundleResult.appName, developerName: iosBundleResult.developerName };
      }
    }
  }

  // Single platform: Android
  if (!developerUrl && platform === 'android') {
    const androidResult = await getDeveloperUrlAndroid(bundleId);
    result.android = androidResult;
    if (androidResult.developerUrl) { developerUrl = androidResult.developerUrl; appMeta = { platform: 'android' }; }
  }

  // Single platform: iOS bundle name
  if (!developerUrl && platform === 'ios' && !isNumericId) {
    const byBundle = await getDeveloperUrlByBundleName(bundleId);
    if (byBundle) {
      result.ios = byBundle;
      if (byBundle.developerUrl) {
        developerUrl = byBundle.developerUrl;
        appMeta = { platform: 'ios', appName: byBundle.appName, developerName: byBundle.developerName };
      }
    }
  }

  result.developerUrl = developerUrl;
  result.appMeta = appMeta;
  result.adsTxt = developerUrl
    ? await fetchAppAdsTxt(developerUrl, keywords)
    : { found: false, error: 'Could not find developer URL', matches: {}, partialMatches: {}, missingLines: {} };

  return result;
}

// Debug: test keyword matching against a live ads.txt URL
app.get('/api/debug-match', async (req, res) => {
  const url = req.query.url;
  const kw = req.query.kw || 'google.com + direct';
  if (!url) return res.status(400).json({ error: 'pass ?url=https://example.com/app-ads.txt&kw=google.com+direct' });
  try {
    const { data } = await axios.get(url, { headers: HEADERS, timeout: 8000 });
    const lines = data.split('\n').map(l => l.trim()).filter(Boolean);
    const { exactLines, partialLines } = matchKeyword(lines, kw);
    res.json({ url, kw, totalLines: lines.length, exactHits: exactLines.length, partialHits: partialLines.length, exactLines: exactLines.slice(0, 10), partialLines: partialLines.slice(0, 10) });
  } catch (err) {
    res.json({ url, kw, error: err.message });
  }
});

app.post('/api/crawl/stream', async (req, res) => {
  const { bundleIds = [], directUrls = [], webUrls = [], keywords, platform = 'both' } = req.body;
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');

  const cleanIds = [...new Set(bundleIds.map(id => id.trim()).filter(Boolean))];
  const cleanUrls = [...new Set(directUrls.map(u => u.trim()).filter(Boolean))];
  const cleanWebUrls = [...new Set(webUrls.map(u => u.trim()).filter(Boolean))];
  const cleanKeywords = keywords.map(k => k.trim()).filter(Boolean);
  const total = cleanIds.length + cleanUrls.length + cleanWebUrls.length;

  res.write(`data: ${JSON.stringify({ type: 'start', total })}\n\n`);

  const limit = pLimit(6);
  let completed = 0;

  const bundleTasks = cleanIds.map(id =>
    limit(async () => {
      const result = await crawlBundle(id, cleanKeywords, platform);
      completed++;
      res.write(`data: ${JSON.stringify({ type: 'result', result, completed, total })}\n\n`);
    })
  );

  const directTasks = cleanUrls.map(url =>
    limit(async () => {
      const adsTxt = await fetchDirectUrl(url, cleanKeywords);
      const result = { bundleId: url, isDirect: true, directUrl: url, adsTxt, developerUrl: url, appMeta: {}, android: null, ios: null };
      completed++;
      res.write(`data: ${JSON.stringify({ type: 'result', result, completed, total })}\n\n`);
    })
  );

  const webTasks = cleanWebUrls.map(url =>
    limit(async () => {
      const domain = normalizeDomain(url) || url;
      const adsTxt = await fetchAdsTxt(url, cleanKeywords);
      const result = { bundleId: url, isWeb: true, developerUrl: domain, adsTxt, appMeta: {}, android: null, ios: null, amazon: null };
      completed++;
      res.write(`data: ${JSON.stringify({ type: 'result', result, completed, total })}\n\n`);
    })
  );

  const heartbeat = setInterval(() => res.write(': heartbeat\n\n'), 25000);
  await Promise.all([...bundleTasks, ...directTasks, ...webTasks]);
  clearInterval(heartbeat);
  res.write(`data: ${JSON.stringify({ type: 'done', total })}\n\n`);
  res.end();
});

app.post('/api/upload-csv', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const name = req.file.originalname.toLowerCase();
  const buf = req.file.buffer;
  let bundleIds = [];

  const allowed = ['.csv', '.txt', '.xlsx', '.xls', '.pdf'];
  if (!allowed.some(ext => name.endsWith(ext))) {
    return res.status(400).json({ error: `Unsupported file type. Allowed: ${allowed.join(', ')}` });
  }

  try {
    if (name.endsWith('.xlsx') || name.endsWith('.xls')) {
      const wb = XLSX.read(buf, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      bundleIds = XLSX.utils.sheet_to_json(ws, { header: 1 })
        .flat().map(c => String(c).trim()).filter(Boolean);

    } else if (name.endsWith('.pdf')) {
      const pdf = await pdfParse(buf);
      bundleIds = pdf.text.split(/[\s,;]+/)
        .map(s => s.trim())
        .filter(s =>
          /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,}$/i.test(s) ||
          /^\d{8,12}$/.test(s)
        );

    } else {
      const records = parse(buf.toString('utf-8'), { skip_empty_lines: true, trim: true });
      bundleIds = records.flat().filter(Boolean);
    }

    // Normalize potential Amazon ASINs: if it looks like an ASIN when uppercased, uppercase it
    bundleIds = bundleIds.map(id => {
      const up = id.toUpperCase();
      return /^B[A-Z0-9]{9}$/.test(up) ? up : id;
    });

    res.json({ bundleIds: [...new Set(bundleIds)] });
  } catch (err) {
    res.status(400).json({ error: 'Parse error: ' + err.message });
  }
});

app.listen(PORT, () => {
  console.log(`\n✅  ads.txt Crawler running at http://localhost:${PORT}\n`);
});
