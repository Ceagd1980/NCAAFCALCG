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

const WEEKDAYS = { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 };

function toIso(label, year) {
  const m = /\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2})\b/i.exec(label || "");
  if (!m) return null;
  const mo = MONTHS[m[1].toLowerCase()], d = +m[2];
  let y = mo <= 3 ? year + 1 : year; // enero = bowls/playoff, año siguiente
  // Si la etiqueta trae el día de la semana, se usa el año en que esa fecha cae ese día
  const wd = /\b(sun|mon|tue|wed|thu|fri|sat)/i.exec(label);
  if (wd) {
    const want = WEEKDAYS[wd[1].toLowerCase()];
    const hit = [y, y - 1, y + 1].find((yy) => new Date(Date.UTC(yy, mo - 1, d)).getUTCDay() === want);
    if (hit) y = hit;
  }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
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
      // Partido jugado: TeamRankings pone el marcador junto a cada equipo ("Miami 24 @ Georgia Tech 21")
      // o en otra celda ("24-21", "W 24-21", "Final 24-21").
      const sc = (raw) => { const m = /\s(\d{1,3})\s*$/.exec(raw.replace(/\(\d+-\d+(-\d+)?\)/g, "").trim()); return m ? +m[1] : null; };
      let awayScore = sc(mm[1]), homeScore = sc(mm[3]);
      let result = "";
      if (awayScore == null || homeScore == null) {
        awayScore = homeScore = null;
        const cell = r.slice(1).find((c) => /\b\d{1,3}\s*[-–]\s*\d{1,3}\b/.test(c) && !/\d{1,2}:\d{2}/.test(c));
        if (cell) result = cell.trim();
      }
      const time = r[iTime] || "";
      games.push({
        date: iso,
        dateLabel,
        away: cleanTeam(mm[1]),
        home: cleanTeam(mm[3]),
        neutral: /^vs/i.test(mm[2]),
        time: /final/i.test(time) || /^\D*\d{1,3}\s*[-–]\s*\d{1,3}\D*$/.test(time) ? "" : time,
        location: r[iLoc] || "",
        awayScore, homeScore,
        result: awayScore != null ? "" : result || (/final/i.test(time) ? time : ""),
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
  ["C-USA", /conference\s*usa|\bC[\s-]*USA\b/i], ["Independientes", /independ|\bind\.?\s*i-?a\b|\bFBS\s*ind/i],
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
    // Récord en casa y fuera (si la tabla trae esas columnas)
    const iHome = idx(/^home$|^casa$|^home\s*w-l/i), iRoad = idx(/^road$|^away$|^fuera$|^road\s*w-l|^away\s*w-l/i);
    const rec = (c) => { const m = /^(\d+)-(\d+)(?:-(\d+))?$/.exec(String(c || "").trim()); return m ? { w: +m[1], l: +m[2], t: +(m[3] || 0), gp: +m[1] + +m[2] + +(m[3] || 0) } : null; };

    const title = titleBefore(html, t.index);
    const plain = title.replace(/\b(standings|conference)\b/gi, "").replace(/\s+/g, " ").trim();
    const base = confName(hdr.join(" ")) || confName(title) || plain || `Conferencia ${ti + 1}`;
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
      const recs = r
        .map((c) => /^(\d+)-(\d+)(?:-(\d+))?$/.exec(c.trim()))
        .filter(Boolean)
        .map((m) => ({ txt: m[0], w: +m[1], l: +m[2], t: +(m[3] || 0) }))
        .map((x) => ({ ...x, g: x.w + x.l + x.t }));
      const best = recs.sort((a, b) => b.g - a.g)[0];
      const record = best ? best.txt : iWL >= 0 ? r[iWL] : "";
      let pct = best && best.g ? (best.w + best.t / 2) / best.g : null;
      if (pct == null && iPct >= 0) {
        pct = num(r[iPct]);
        if (pct != null && pct > 1) pct = pct / 100;
      }
      map[key(cleanTeam(r[iT]))] = {
        team: r[iT], pos, div: conf,
        powerRank: iRank >= 0 ? num(r[iRank]) : null,
        record,
        confRecord: iConf >= 0 ? r[iConf] : "",
        w: best ? best.w : null, l: best ? best.l : null, t: best ? best.t : 0, gp: best ? best.g : null,
        home: iHome >= 0 ? rec(r[iHome]) : null,
        road: iRoad >= 0 ? rec(r[iRoad]) : null,
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

// Lista de semanas del selector "Week:" de TeamRankings (<option value="1284">Week 4 ...</option>)
function parseWeeks(html, requested) {
  if (!html) return [];
  const sel = /<select[^>]*(?:week)[^>]*>([\s\S]*?)<\/select>/i.exec(html);
  const src = sel ? sel[1] : html;
  const out = [];
  for (const m of src.matchAll(/<option([^>]*)value="(\d{2,6})"([^>]*)>([\s\S]*?)<\/option>/gi)) {
    const attrs = m[1] + m[3];
    out.push({ id: m[2], label: decode(m[4]), selected: requested ? m[2] === requested : /selected/i.test(attrs) });
  }
  return out;
}

// Diagnóstico: /api/ncaaf?debug=weeks → cómo pedir semanas pasadas a TeamRankings
async function debugWeeks() {
  const out = {};
  try {
    const html = await (await fetch(URLS.schedule, { headers: HEADERS })).text();
    const opts = [...html.matchAll(/<option[^>]*value="([^"]*)"[^>]*>([\s\S]*?)<\/option>/gi)].map((m) => [m[1], decode(m[2])]).slice(0, 40);
    const links = [...new Set([...html.matchAll(/href="([^"]*(?:week|date|season|scores)[^"]*)"/gi)].map((m) => m[1]))].slice(0, 40);
    const dates = parseTables(html).flatMap((t) => t.rows.map((r) => r[0])).filter((c) => /\b(mon|tue|wed|thu|fri|sat|sun)\b/i.test(c || "")).slice(0, 12);
    out.temporada = { opciones: opts, enlaces: links, fechasEnPagina: dates };
  } catch (e) { out.temporada = { error: e.message }; }
  const cands = [
    `${NCF}/schedules/season/?week=4`, `${NCF}/schedules/season/?date=2026-09-19`,
    `${NCF}/schedules/?date=2026-09-19`, `${NCF}/scores/?date=2026-09-19`, `${NCF}/scores/`,
  ];
  out.pruebas = await Promise.all(cands.map(async (u) => {
    try {
      const r = await fetch(u, { headers: HEADERS });
      const html = await r.text();
      const t = parseTables(html);
      return { url: u, status: r.status, tablas: t.length, primeras: t.slice(0, 2).map((x) => x.rows.slice(0, 4)) };
    } catch (e) { return { url: u, error: e.message }; }
  }));
  return out;
}

// ---------- fuerza relativa (FR): resultados de cada equipo desde su página en TeamRankings ----------
// Las direcciones de las páginas de equipo se toman de los enlaces de las tablas (posiciones y estadísticas).
function teamPaths(...htmls) {
  const out = {};
  const re = /<a[^>]*href="(?:https?:\/\/www\.teamrankings\.com)?(\/[a-z-]+\/team\/[a-z0-9-]+)\/?"[^>]*>([\s\S]*?)<\/a>/gi;
  for (const html of htmls) {
    if (!html) continue;
    let m;
    while ((m = re.exec(html))) {
      const txt = decode(m[2]).replace(/\(\d+-\d+(-\d+)?\)/g, "").replace(/^#?\d+\s+/, "").trim();
      if (!/[a-z]/i.test(txt)) continue;
      const k = key(txt);
      if (k && !out[k]) out[k] = m[1];
    }
  }
  return out;
}
const FR_MONTHS = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
function frIso(txt, refIso) {
  const t = String(txt || "").trim();
  let y = null, mo = null, d = null, m;
  if ((m = /(\d{4})-(\d{1,2})-(\d{1,2})/.exec(t))) [y, mo, d] = [+m[1], +m[2], +m[3]];
  else if ((m = /(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/.exec(t))) { mo = +m[1]; d = +m[2]; if (m[3]) y = +m[3] < 100 ? 2000 + +m[3] : +m[3]; }
  else if ((m = /([A-Za-z]{3})[a-z]*\.?\s+(\d{1,2})/.exec(t)) && FR_MONTHS[m[1].toLowerCase()]) { mo = FR_MONTHS[m[1].toLowerCase()]; d = +m[2]; }
  if (!mo || !d) return null;
  if (!y) { const [ry, rm] = refIso.split("-").map(Number); y = mo - rm > 6 ? ry - 1 : rm - mo > 6 ? ry + 1 : ry; }
  return `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}
// Todos los resultados de la temporada de un equipo: columna "Result" ("W 88-80") y "Date"
function parseResults(html, refIso) {
  const games = [];
  for (const t of parseTables(html)) {
    const hi = t.rows.findIndex((r) => r.some((c) => /^result$/i.test(c.trim())));
    if (hi < 0) continue;
    const hdr = t.rows[hi].map((c) => c.trim());
    const iD = hdr.findIndex((c) => /^date$/i.test(c)), iR = hdr.findIndex((c) => /^result$/i.test(c));
    if (iD < 0) continue;
    for (const r of t.rows.slice(hi + 1)) {
      const m = /^([WLT])\b\s*(\d+)\s*[-–]\s*(\d+)/i.exec((r[iR] || "").trim());
      const date = frIso(r[iD], refIso);
      if (m && date) games.push({ date, wl: m[1].toUpperCase(), score: `${m[2]}-${m[3]}` });
    }
  }
  return games.sort((a, b) => a.date.localeCompare(b.date));
}
async function frFetch(url, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { headers: HEADERS, signal: ctrl.signal, redirect: "follow" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return await r.text();
  } catch (e) {
    throw e.name === "AbortError" ? new Error("tiempo de espera agotado") : e;
  } finally { clearTimeout(timer); }
}
const ecToday = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
const PATH_RE = /^\/[a-z-]+\/team\/[a-z0-9-]+$/;
// ?part=form&p=/ruta1,/ruta2,... (hasta 12 equipos por llamada) → resultados de cada equipo
async function formResponse(pParam) {
  const T0 = Date.now(), ref = ecToday();
  const paths = [...new Set(String(pParam || "").split(",").map((s) => s.trim()).filter((s) => PATH_RE.test(s)))].slice(0, 12);
  const teams = {}, errs = [];
  await Promise.all(paths.map(async (p) => {
    const left = 9000 - (Date.now() - T0);
    try {
      const html = await frFetch(`https://www.teamrankings.com${p}`, Math.min(5000, left));
      if (!/>\s*Result\s*</i.test(html)) { errs.push(`${p.split("/").pop()}: la página no trae la tabla de resultados`); return; }
      teams[p] = parseResults(html, ref); // vacío = todavía sin partidos jugados
    } catch (e) { errs.push(`${p.split("/").pop()}: ${e.message}`); }
  }));
  const ok = true;
  return json({ ok, teams, warnings: errs.length ? [`Fuerza relativa: ${errs.join(" · ")}`] : [] }, 200,
    !errs.length ? {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=1800, stale-while-revalidate=3600",
      "Netlify-Vary": "query=week|part|p",
    } : { "Cache-Control": "no-store" });
}

export default async (req) => {
  { const qs = req ? new URL(req.url).searchParams : new URLSearchParams(); if (qs.get("part") === "form") return formResponse(qs.get("p")); }
  if (typeof req !== "undefined" && req && new URL(req.url).searchParams.get("debug") === "weeks")
    return json(await debugWeeks(), 200, { "Cache-Control": "no-store" });
  // ?week=1284 → semana concreta del calendario de TeamRankings (semanas pasadas o futuras)
  const weekParam = req ? new URL(req.url).searchParams.get("week") : null;
  const week = weekParam && /^\d{1,6}$/.test(weekParam) ? weekParam : null;
  const names = ["schedule", "standings", ...STAT_KEYS];
  const urlOf = (k) => (k === "schedule" && week ? `${URLS.schedule}?week=${week}` : URLS[k]);
  const results = await Promise.allSettled(names.map((k) => getHtml(urlOf(k))));

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
  // Dirección de la página de cada equipo (para la fuerza relativa)
  const paths = teamPaths(html.standings, ...STAT_KEYS.map((k) => html[k]), html.schedule);
  const noPath = [];
  for (const [n, t] of Object.entries(teams)) { t.path = paths[key(n)] || null; if (!t.path && t.pts) noPath.push(n); }
  if (noPath.length) warnings.push(`Fuerza relativa: sin enlace a la página de ${noPath.sort().join(", ")}`);

  return json(
    { ok: true, updated: new Date().toISOString(), games, teams, warnings, weeks: parseWeeks(html.schedule, week), week },
    200,
    {
      "Cache-Control": "public, max-age=0, must-revalidate",
      "Netlify-CDN-Cache-Control": "public, durable, s-maxage=900, stale-while-revalidate=3600",
      "Netlify-Vary": "query=week|part|p",
    }
  );
};

export const config = { path: "/api/ncaaf" };
