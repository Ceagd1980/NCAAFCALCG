// Radar NCAAF — función de Netlify que lee TeamRankings.com y devuelve JSON.
// Sin dependencias externas: usa fetch nativo (Node 18+) y un lector de tablas HTML propio.

const NCF = "https://www.teamrankings.com/ncf";
const STAT = "https://www.teamrankings.com/college-football/stat";
const URLS = {
  schedule: `${NCF}/schedules/season/`,
  standings: `${NCF}/standings/`,
  pts: `${STAT}/points-per-game`,
  td: `${STAT}/offensive-touchdowns-per-game`,
  ypp: `${STAT}/yards-per-point`,
  yds: `${STAT}/yards-per-game`,
};
const STAT_KEYS = ["pts", "td", "ypp", "yds"];

const HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Cache-Control": "no-cache",
};

// ---------- nombres de equipos ----------
// En universitario hay nombres muy parecidos (Texas / Texas St / Texas Tech / Texas Southern,
// Miami / Miami OH, etc.), así que NO se usa búsqueda parcial: solo nombre exacto normalizado.
// Palabras equivalentes: "Northern Illinois" = "N Illinois", "Boise State" = "Boise St"...
const WORDS = {
  state: "st", st: "st", north: "n", northern: "n", south: "s", southern: "s",
  east: "e", eastern: "e", west: "w", western: "w", central: "c", saint: "st",
  univ: "", university: "", the: "", of: "",
  florida: "fla", fla: "fla", fl: "fla", ohio: "oh", oh: "oh",
};
// Casos puntuales (clave normalizada -> clave común)
const ALIAS = {
  miamifla: "miami", // Miami (FL) = Miami
  jmadison: "jamesmadison",
  mississippi: "olemiss",
  ucf: "cfla", // UCF = Central Florida
  usf: "sfla", // USF = South Florida
  fiu: "fla international", fau: "flaatlantic",
  lsu: "louisianast", byu: "brighamyoung", tcu: "texaschristian", smu: "smethodist",
  utep: "texaselpaso", utsa: "texassanantonio", uab: "alabamabirmingham",
  unlv: "nevadalasvegas", uconn: "connecticut", umass: "massachusetts",
  ulmonroe: "louisianamonroe", ullafayette: "louisiana", louisianalafayette: "louisiana",
  gatech: "georgiatech", ncst: "nst", ncstate: "nst", nst: "nst",
  usc: "scalifornia", ucla: "ucla", pitt: "pittsburgh", ncarolinast: "nst",
  smississippi: "smiss", gas: "georgias", appst: "appalachianst", lamonroe: "louisianamonroe",
  latech: "louisianatech", midtennessee: "mtsu", middletennessee: "mtsu", midtennst: "mtsu",
  flaintl: "flainternational", bostoncol: "bostoncollege", coastalcar: "coastalcarolina",
  samhouston: "samhoustonst", nmst: "newmexicost", sjst: "sanjosest", sanjosst: "sanjosest",
};
for (const k of Object.keys(ALIAS)) ALIAS[k] = ALIAS[k].replace(/[^a-z]/g, "");

function key(s) {
  const words = String(s || "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/&/g, "")
    .replace(/[().,'’\-]/g, " ")
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => (w in WORDS ? WORDS[w] : w));
  const k = words.join("").replace(/[^a-z]/g, "");
  return ALIAS[k] || k;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function num(v) {
  if (v == null) return null;
  const n = parseFloat(String(v).replace(/[^\d.\-]/g, ""));
  return Number.isFinite(n) ? n : null;
}

// ---------- descarga con reintento y límite de tiempo ----------
async function getHtml(url, tries = 2, timeoutMs = 4000) {
  let lastErr;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: "follow" });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const html = await r.text();
      if (!/<table/i.test(html)) throw new Error("la página no trae tablas (posible bloqueo)");
      return html;
    } catch (e) {
      lastErr = e.name === "AbortError" ? new Error("tiempo de espera agotado") : e;
      if (i < tries - 1) await sleep(350);
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error(lastErr ? lastErr.message : "error desconocido");
}

// ---------- lector de tablas HTML ----------
function decode(s) {
  return s
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16)))
    .replace(/&([a-z])(acute|grave|tilde|uml|circ|cedil);/gi, (_, c, t) =>
      (c + { acute: "\u0301", grave: "\u0300", tilde: "\u0303", uml: "\u0308", circ: "\u0302", cedil: "\u0327" }[t.toLowerCase()]).normalize("NFC"))
    .replace(/\s+/g, " ")
    .trim();
}

function parseTables(html) {
  const out = [];
  const reTable = /<table[\s\S]*?<\/table>/gi;
  let m;
  while ((m = reTable.exec(html))) {
    const rows = [];
    const reRow = /<tr[\s\S]*?<\/tr>/gi;
    let r;
    while ((r = reRow.exec(m[0]))) {
      const cells = [];
      const reCell = /<t([hd])[^>]*>([\s\S]*?)<\/t\1>/gi;
      let c;
      while ((c = reCell.exec(r[0]))) cells.push(decode(c[2]));
      if (cells.length) rows.push(cells);
    }
    out.push({ index: m.index, rows });
  }
  return out;
}

// ---------- calendario de la temporada ----------
// Formato: filas de fecha ("Sun Sep 13 | Time | Location") seguidas de partidos
// ("Buffalo @ Houston | 1:00 PM | Reliant Stadium"). "vs." = campo neutral.
const MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function seasonYear(html) {
  const m = /(\d{4})\s+(?:College Football|NCAAF?|CFB)?\s*(?:Football\s+)?Schedule/i.exec(html);
  if (m) return +m[1];
  const d = new Date();
  return d.getUTCMonth() < 3 ? d.getUTCFullYear() - 1 : d.getUTCFullYear();
}

function toIso(label, year) {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(label || "");
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()];
  const y = mo <= 3 ? year + 1 : year; // enero-marzo = playoffs, año siguiente
  return `${y}-${String(mo).padStart(2, "0")}-${String(+m[2]).padStart(2, "0")}`;
}

const cleanTeam = (s) => s.replace(/\(\d+-\d+(-\d+)?\)/g, "").replace(/^#\d+\s+/, "").replace(/\s+\d+$/, "").trim();

function parseSchedule(html) {
  const year = seasonYear(html);
  const games = [];
  const tables = parseTables(html).filter((t) =>
    t.rows.some((r) => r.some((c) => /\s(@|at|vs\.?)\s/i.test(c)))
  );
  for (const t of tables) {
    let dateLabel = "", iso = null, iTime = 1, iLoc = 2;
    for (const r of t.rows) {
      const first = r[0] || "";
      // Fila de fecha / cabecera
      if (r.some((c) => /^time$/i.test(c)) || (toIso(first, year) && !/\s(@|at|vs\.?)\s/i.test(first))) {
        if (toIso(first, year)) { dateLabel = first; iso = toIso(first, year); }
        const it = r.findIndex((c) => /^time$/i.test(c)), il = r.findIndex((c) => /location/i.test(c));
        if (it >= 0) iTime = it;
        if (il >= 0) iLoc = il;
        continue;
      }
      const mm = first.match(/^(.+?)\s+(@|at|vs\.?)\s+(.+)$/i);
      if (!mm) continue;
      games.push({
        date: iso,
        dateLabel,
        away: cleanTeam(mm[1]),
        home: cleanTeam(mm[3]),
        neutral: /^vs/i.test(mm[2]),
        time: r[iTime] || "",
        location: r[iLoc] || "",
      });
    }
  }
  return games;
}

// ---------- tabla de posiciones (una tabla por conferencia) ----------
const CONFS = [
  ["SEC", /\bSEC\b|southeastern/i], ["Big Ten", /big\s*ten|big\s*10/i], ["Big 12", /big\s*12|big\s*twelve/i],
  ["ACC", /\bACC\b|atlantic\s*coast/i], ["Pac-12", /pac[\s-]*12/i], ["American", /\bAAC\b|american\s*athletic|^american\b/i],
  ["Mountain West", /mountain\s*west|\bMWC\b/i], ["Sun Belt", /sun\s*belt/i], ["MAC", /\bMAC\b|mid[\s-]*american/i],
  ["C-USA", /conference\s*usa|\bC[\s-]*USA\b/i], ["Independientes", /independ/i],
];
const ZONE = { east: "Este", west: "Oeste", north: "Norte", south: "Sur" };

function confName(text) {
  const t = String(text || "").replace(/\s+/g, " ").trim();
  for (const [name, re] of CONFS) if (re.test(t)) return name;
  return null;
}

// Texto del último título (h1-h5, caption, strong) antes de la tabla
function titleBefore(html, index) {
  const before = html.slice(Math.max(0, index - 3000), index);
  const re = /<(h[1-5]|caption|strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let m, last = "";
  while ((m = re.exec(before))) last = decode(m[2]);
  return last;
}

function parseStandings(html) {
  // Cabecera: fila con columnas de récord (W-L / Overall / Pct) y sin números de partidos
  const isHdr = (r) =>
    r.length >= 2 && r.some((c) => /pct|w-l|overall|record/i.test(c)) && !r.some((c) => /^\d+-\d+/.test(c));
  const tables = parseTables(html).filter((t) => t.rows.some(isHdr));
  const map = {};
  tables.forEach((t, ti) => {
    const hdr = t.rows.find(isHdr);
    const idx = (re, from = 0) => hdr.findIndex((c, i) => i >= from && re.test(c));
    let iT = idx(/^team$|^school$/i);
    if (iT < 0) iT = 0;
    const iRank = idx(/^rank$/i);
    // Récord general (no el de conferencia) y su porcentaje
    let iWL = idx(/overall/i);
    if (iWL < 0) iWL = hdr.findIndex((c) => /w-l/i.test(c) && !/conf/i.test(c));
    let iPct = iWL >= 0 ? idx(/pct|%/i, iWL) : -1;
    if (iPct < 0) iPct = idx(/pct|%/i);
    const iConf = hdr.findIndex((c) => /conf/i.test(c) && /w-l|record/i.test(c));
    const iStreak = idx(/streak|strk/i);

    const base = confName(hdr.join(" ")) || confName(titleBefore(html, t.index)) || titleBefore(html, t.index) || `Conferencia ${ti + 1}`;
    let conf = base, pos = 0;
    for (const r of t.rows) {
      const label = isHdr(r) || r.length < 3 || r.every((c) => !/\d/.test(c));
      if (label) {
        const txt = r.join(" ");
        const c = confName(txt);
        const z = /\b(East|West|North|South)\b/i.exec(txt);
        if (c || z) { conf = (c || base) + (z ? ` ${ZONE[z[1].toLowerCase()]}` : ""); pos = 0; }
        continue;
      }
      if (!r[iT]) continue;
      pos++;
      const record = iWL >= 0 ? r[iWL] : "";
      let pct = iPct >= 0 ? num(r[iPct]) : null;
      if (pct != null && pct > 1) pct = pct / 100;
      if (pct == null) {
        const m = /(\d+)-(\d+)(?:-(\d+))?/.exec(record);
        if (m) { const w = +m[1], l = +m[2], tt = +(m[3] || 0); pct = w + l + tt ? (w + tt / 2) / (w + l + tt) : null; }
      }
      map[key(cleanTeam(r[iT]))] = {
        team: r[iT], pos, div: conf,
        powerRank: iRank >= 0 ? num(r[iRank]) : null,
        record,
        confRecord: iConf >= 0 ? r[iConf] : "",
        pct,
        streak: iStreak >= 0 ? r[iStreak] : "",
      };
    }
  });
  if (!Object.keys(map).length) throw new Error("tabla de posiciones no encontrada");
  return map;
}

// ---------- páginas de estadística (Temporada, Last 3, Home, Away) ----------
function parseStat(html) {
  const isHdr = (r) => r.includes("Team") && r.includes("Home") && r.includes("Away");
  const t = parseTables(html).find((t) => t.rows.some(isHdr));
  if (!t) throw new Error("tabla de estadística no encontrada");
  const hdr = t.rows.find(isHdr);
  const iT = hdr.indexOf("Team"), iH = hdr.indexOf("Home"), iA = hdr.indexOf("Away"),
    iL3 = hdr.findIndex((c) => /last\s*3/i.test(c));
  let iS = hdr.findIndex((c, i) => i > iT && /^\d{4}$/.test(c)); // columna del año actual
  if (iS < 0) iS = iT + 1;

  const map = {};
  for (const r of t.rows) {
    if (isHdr(r) || !r[iT]) continue;
    map[key(cleanTeam(r[iT]))] = {
      season: num(r[iS]),
      last3: iL3 >= 0 ? num(r[iL3]) : null,
      home: num(r[iH]),
      away: num(r[iA]),
    };
  }
  return map;
}

// Búsqueda solo por nombre exacto normalizado (evita mezclar Texas con Texas St o Texas Southern)
function find(map, name) {
  if (!map) return null;
  return map[key(name)] || null;
}

const json = (body, status, extra = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...extra },
  });

export default async () => {
  const names = ["schedule", "standings", ...STAT_KEYS];
  const results = await Promise.allSettled(names.map((k) => getHtml(URLS[k])));

  const warnings = [];
  const html = {};
  results.forEach((r, i) => {
    if (r.status === "fulfilled") html[names[i]] = r.value;
    else warnings.push(`${names[i]}: ${r.reason?.message || r.reason}`);
  });

  if (!html.schedule) {
    return json(
      { ok: false, error: "No se pudo leer el calendario de TeamRankings.", warnings },
      502,
      { "Cache-Control": "no-store" }
    );
  }

  const safe = (label, fn, src) => {
    if (!src) return null;
    try { return fn(src); } catch (e) { warnings.push(`${label}: ${e.message}`); return null; }
  };

  const games = safe("schedule", parseSchedule, html.schedule) || [];
  if (!games.length) warnings.push("schedule: no se encontraron partidos en el calendario");
  const standings = safe("standings", parseStandings, html.standings);
  const stats = {};
  for (const k of STAT_KEYS) stats[k] = safe(k, parseStat, html[k]);

  const warned = new Set();
  const noData = [];
  const team = (name) => {
    const t = { name, standing: find(standings, name) };
    for (const k of STAT_KEYS) t[k] = find(stats[k], name);
    const loaded = { standing: standings, ...stats };
    const missing = Object.keys(loaded).filter((k) => loaded[k] && !t[k]);
    if (missing.length && !warned.has(name)) {
      warned.add(name);
      if (stats.pts && missing.length === Object.keys(loaded).filter((k) => loaded[k]).length) noData.push(name);
      else warnings.push(`${name}: sin datos en ${missing.join(", ")}`);
    }
    return t;
  };

  // Cada equipo se envía una sola vez; los partidos solo llevan el nombre
  const teams = {};
  for (const g of games) for (const n of [g.home, g.away]) if (!teams[n]) teams[n] = team(n);
  if (noData.length)
    warnings.push(`Sin estadísticas (normalmente equipos FCS): ${noData.sort().join(", ")}`);

  return json(
    { ok: true, updated: new Date().toISOString(), games, teams, warnings },
    200,
    {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=900, stale-while-revalidate=3600",
    }
  );
};

export const config = { path: "/api/ncaaf" };
