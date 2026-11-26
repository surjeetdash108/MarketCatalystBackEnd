/**
 * The closing recap's numbers and its pre-publish checks (26 Nov 2026 audit,
 * B-20 / B-22 / B-25 / B-26).
 *
 * Every figure the recap prints for an index, a commodity or a coin comes
 * from the instrument itself (FMP `^DJI`, `^GSPC`, `XAUUSD`, `BTCUSD`, …),
 * never from an ETF stand-in: the Nov 25 recap printed DIA×100 as the Dow,
 * USO's share price as crude oil, GLD as gold and IBIT as bitcoin. The tables
 * are then written by code from these rows, so the model cannot restate them,
 * and the checks below hold any recap whose prose disagrees with them.
 */

export type RecapKind = "index" | "volatility" | "commodity" | "crypto" | "fx";

export interface RecapInstrument {
  /** Row key, stable across runs. */
  id: string;
  /** Vendor symbol of the instrument itself. */
  symbol: string;
  /** The name printed in the tables. */
  label: string;
  kind: RecapKind;
  /** Words that name it in prose (for the figure check); "the gold ETF (GLD)" is the ETF, not gold. */
  words: RegExp;
  /** "$" for commodities/crypto, "" for index points. */
  unit: "" | "$";
}

/** What the recap prints, in table order. */
export const RECAP_INSTRUMENTS: RecapInstrument[] = [
  {
    id: "DJI",
    symbol: "^DJI",
    label: "DJIA",
    kind: "index",
    words: /\b(Dow(?: Jones)?(?: Industrial Average)?|DJIA)\b/i,
    unit: "",
  },
  {
    id: "SPX",
    symbol: "^GSPC",
    label: "S&P 500",
    kind: "index",
    words: /\bS&(?:amp;)?P(?: 500)?\b/i,
    unit: "",
  },
  {
    id: "IXIC",
    symbol: "^IXIC",
    label: "Nasdaq Composite",
    kind: "index",
    words: /\bNasdaq(?: Composite)?\b(?!-100| 100)/i,
    unit: "",
  },
  {
    id: "RUT",
    symbol: "^RUT",
    label: "Russell 2000",
    kind: "index",
    words: /\bRussell(?: 2000)?\b/i,
    unit: "",
  },
  {
    id: "VIX",
    symbol: "^VIX",
    label: "CBOE VIX ($VIX)",
    kind: "volatility",
    words: /\bVIX\b/i,
    unit: "",
  },
  {
    id: "WTI",
    symbol: "CLUSD",
    label: "WTI crude ($/bbl)",
    kind: "commodity",
    words:
      /\b(WTI|crude|oil)\b(?!\s+(?:ETF|ETFs|ETN|fund|miners|stocks|Trust|Shares|producers)\b)/i,
    unit: "$",
  },
  {
    id: "BRENT",
    symbol: "BZUSD",
    label: "Brent crude ($/bbl)",
    kind: "commodity",
    words:
      /\bBrent\b(?!\s+(?:ETF|ETFs|ETN|fund|miners|stocks|Trust|Shares|producers)\b)/i,
    unit: "$",
  },
  {
    id: "GOLD",
    symbol: "XAUUSD",
    label: "Gold, spot ($/oz)",
    kind: "commodity",
    words:
      /\bgold\b(?!\s+(?:ETF|ETFs|ETN|fund|miners|stocks|Trust|Shares|producers)\b)/i,
    unit: "$",
  },
  {
    id: "BTC",
    symbol: "BTCUSD",
    label: "Bitcoin (BTC/USD)",
    kind: "crypto",
    words:
      /\bbitcoin\b(?!\s+(?:ETF|ETFs|ETN|fund|miners|stocks|Trust|Shares|producers)\b)/i,
    unit: "$",
  },
  {
    id: "ETH",
    symbol: "ETHUSD",
    label: "Ethereum (ETH/USD)",
    kind: "crypto",
    words:
      /\b(ether|ethereum)\b(?!\s+(?:ETF|ETFs|ETN|fund|miners|stocks|Trust|Shares|producers)\b)/i,
    unit: "$",
  },
];

export interface QuoteLike {
  symbol: string;
  price: number | null;
  change: number | null;
  changePercentage: number | null;
  previousClose: number | null;
  timestamp: number | null;
  yearHigh?: number | null;
  yearLow?: number | null;
}

export interface RecapRow {
  id: string;
  label: string;
  kind: RecapKind;
  unit: "" | "$";
  close: number;
  change: number;
  pctChange: number;
  /** Unix seconds of the print. */
  asOf: number;
}

const fin = (v: unknown): v is number =>
  typeof v === "number" && Number.isFinite(v);

/**
 * One row per instrument the vendor priced. A quote outside its own 52-week
 * range by more than a fifth is a bad print and is left out rather than shown.
 */
export function recapRows(quotes: QuoteLike[]): RecapRow[] {
  const rows: RecapRow[] = [];
  for (const ins of RECAP_INSTRUMENTS) {
    const q = quotes.find((x) => x.symbol === ins.symbol);
    if (!q || !fin(q.price) || !fin(q.timestamp)) continue;
    const prev = fin(q.previousClose) ? q.previousClose : null;
    const change =
      prev != null ? q.price - prev : fin(q.change) ? q.change : null;
    const pct = prev
      ? ((q.price - prev) / prev) * 100
      : fin(q.changePercentage)
        ? q.changePercentage
        : null;
    if (change == null || pct == null) continue;
    if (
      fin(q.yearHigh) &&
      fin(q.yearLow) &&
      (q.price > q.yearHigh * 1.2 || q.price < q.yearLow * 0.8)
    )
      continue;
    rows.push({
      id: ins.id,
      label: ins.label,
      kind: ins.kind,
      unit: ins.unit,
      close: q.price,
      change,
      pctChange: pct,
      asOf: q.timestamp,
    });
  }
  return rows;
}

const ET = "America/New_York";

/** Unix seconds of 4:00 PM ET on an ET calendar day ("2026-11-25"). */
export function closeBellSeconds(day: string): number {
  // 16:00 ET is 21:00Z in winter and 20:00Z in summer; take the one whose ET hour is 16.
  for (const h of [20, 21]) {
    const t = Date.parse(`${day}T${String(h).padStart(2, "0")}:00:00Z`);
    const etHour = Number(
      new Intl.DateTimeFormat("en-US", {
        timeZone: ET,
        hour: "numeric",
        hour12: false,
      }).format(new Date(t)),
    );
    if (etHour === 16) return t / 1000;
  }
  return Date.parse(`${day}T21:00:00Z`) / 1000;
}

/**
 * The closes are final only once every stock index printed at or after the
 * 4:00 PM bell of the session day. Before that the "close" is an intraday
 * price (Nov 24: Dow 49,964 published against the official 50,018.70).
 */
export function closeReasons(rows: RecapRow[], sessionDay: string): string[] {
  const bell = closeBellSeconds(sessionDay);
  const out: string[] = [];
  for (const id of ["DJI", "SPX", "IXIC"]) {
    const r = rows.find((x) => x.id === id);
    if (!r)
      out.push(
        `No official close for ${RECAP_INSTRUMENTS.find((i) => i.id === id)?.label}`,
      );
    else if (r.asOf < bell)
      out.push(`${r.label} figure is not the final close yet`);
  }
  return out;
}

// ── formatting (one place, so tables and checks agree) ─────────────────────────

const decimalsFor = (r: Pick<RecapRow, "kind" | "close">) =>
  r.kind === "crypto" && r.close >= 1000 ? 0 : 2;

export function fmtClose(r: Pick<RecapRow, "kind" | "close" | "unit">): string {
  const d = decimalsFor(r);
  return `${r.unit}${r.close.toLocaleString("en-US", { minimumFractionDigits: d, maximumFractionDigits: d })}`;
}

export function fmtChange(
  r: Pick<RecapRow, "kind" | "close" | "unit" | "change">,
): string {
  const d = decimalsFor(r);
  const s = Math.abs(r.change).toLocaleString("en-US", {
    minimumFractionDigits: d,
    maximumFractionDigits: d,
  });
  return `${r.change < 0 ? "-" : "+"}${r.unit}${s}`;
}

export function fmtPct(p: number): string {
  return `${p < 0 ? "-" : "+"}${Math.abs(p).toFixed(2)}%`;
}

const cls = (v: number, kind: RecapKind) =>
  kind === "volatility" ? "" : v < 0 ? "neg" : v > 0 ? "pos" : "";

function rowHtml(r: RecapRow, note: string): string {
  const c = cls(r.pctChange, r.kind);
  const td = (v: string) =>
    c ? `<td class="${c}">${v}</td>` : `<td>${v}</td>`;
  return `<tr><td class="metric">${escapeHtml(r.label)}</td><td>${fmtClose(r)}</td>${td(fmtChange(r))}${td(fmtPct(r.pctChange))}<td>${note}</td></tr>`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The model's own note cell for a row it wrote, kept when the row matches by name. */
function notesByLabel(tableHtml: string): Map<string, string> {
  const m = new Map<string, string>();
  for (const tr of tableHtml.match(/<tr>[\s\S]*?<\/tr>/g) ?? []) {
    const cells = [...tr.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(
      (x) => x[1],
    );
    if (cells.length >= 5)
      m.set(
        cells[0]
          .replace(/<[^>]+>/g, "")
          .trim()
          .toLowerCase(),
        cells[cells.length - 1],
      );
  }
  return m;
}

function noteFor(notes: Map<string, string>, r: RecapRow): string {
  const ins = RECAP_INSTRUMENTS.find((i) => i.id === r.id)!;
  for (const [k, v] of notes)
    if (ins.words.test(k) || k === r.label.toLowerCase()) return v;
  return "";
}

/**
 * Rewrites the "numbers by the close" stat boxes, the index table and the
 * cross-asset table from the rows. The model's notes ("Tech pullback") are
 * kept; its figures are not.
 */
export function applyRecapRows(
  html: string,
  rows: RecapRow[],
  yield10: { value: number | null; changeBps: number | null },
): string {
  let out = html;
  const idx = rows.filter((r) => r.kind === "index" || r.kind === "volatility");
  const cross = rows.filter(
    (r) => r.kind === "commodity" || r.kind === "crypto",
  );

  // Index table: the first table after the "numbers" heading.
  out = out.replace(
    /(<h2 id="numbers"[\s\S]*?<tbody>)([\s\S]*?)(<\/tbody>)/i,
    (_m, a: string, body: string, c: string) => {
      const notes = notesByLabel(body);
      return `${a}\n${idx.map((r) => rowHtml(r, noteFor(notes, r))).join("\n")}\n${c}`;
    },
  );

  // Stat boxes: Dow, S&P 500, Nasdaq, Russell 2000 in that order.
  const boxes = ["DJI", "SPX", "IXIC", "RUT"]
    .map((id) => rows.find((r) => r.id === id))
    .filter((r): r is RecapRow => !!r);
  out = out.replace(
    /(<h2 id="numbers"[^>]*>[\s\S]*?)(<div class="stat-strip">[\s\S]*?<\/div>\s*)(?=<div class="post-doc-scroll">)/i,
    (_m, a: string) => {
      const names: Record<string, string> = {
        DJI: "Dow Jones",
        SPX: "S&amp;P 500",
        IXIC: "Nasdaq",
        RUT: "Russell 2000",
      };
      const boxHtml = boxes
        .map(
          (r) =>
            `  <div class="stat-box${r.pctChange < 0 ? " neg" : ""}">\n    <div class="num">${fmtPct(r.pctChange)}</div>\n    <div class="label">${names[r.id]} (${fmtClose(r)}, ${fmtChange(r)} pts)</div>\n  </div>`,
        )
        .join("\n");
      return `${a}<div class="stat-strip">\n${boxHtml}\n</div>\n`;
    },
  );

  // Cross-asset table: 10Y yield first, then commodities and crypto.
  out = out.replace(
    /(<h2 id="cross-asset"[\s\S]*?<tbody>)([\s\S]*?)(<\/tbody>)/i,
    (_m, a: string, body: string, c: string) => {
      const notes = notesByLabel(body);
      const lines: string[] = [];
      if (yield10.value != null) {
        const bps = yield10.changeBps;
        const bc = bps == null ? "" : bps;
        const note =
          [...notes].find(([k]) => /yield|treasury/.test(k))?.[1] ?? "";
        lines.push(
          `<tr><td class="metric">10Y Treasury Yield</td><td>${yield10.value.toFixed(2)}%</td><td>${bc === "" ? "—" : `${Number(bc) >= 0 ? "+" : ""}${bc} bps`}</td><td>—</td><td>${note}</td></tr>`,
        );
      }
      for (const r of cross) lines.push(rowHtml(r, noteFor(notes, r)));
      return `${a}\n${lines.join("\n")}\n${c}`;
    },
  );
  return out;
}

// ── checks ─────────────────────────────────────────────────────────────────────

const WEEKDAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

/** "Wednesday" for "2026-11-25" (the session's own weekday, not today's). */
export function weekdayOf(day: string): string {
  return WEEKDAYS[new Date(`${day}T12:00:00Z`).getUTCDay()];
}

const textOf = (html: string) =>
  html
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&nbsp;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

/** The body before "What to watch next": the part that describes the session itself. */
function sessionPart(html: string): string {
  const i = html.search(/<h2 id="(calendar|risks)"/i);
  return i >= 0 ? html.slice(0, i) : html;
}

/**
 * The session is described with its own weekday (B-22: "Broad indices close
 * mixed on Friday" for Wednesday, Nov 25). Only the title, dek and the session
 * part of the body are read; the look-ahead sections name future days.
 */
export function weekdayReasons(
  title: string,
  dek: string,
  html: string,
  sessionDay: string,
): string[] {
  const own = weekdayOf(sessionDay);
  const text = `${title} ${dek} ${textOf(sessionPart(html))}`;
  const wrong = WEEKDAYS.filter(
    (d) =>
      d !== own &&
      new RegExp(
        `\\b(on|this|today,?|session|close[sd]?)\\s+${d}\\b|\\b${d}('s)?\\s+(session|close|trading)\\b`,
        "i",
      ).test(text),
  );
  return wrong.length ? [`Calls the ${own} session "${wrong.join(", ")}"`] : [];
}

const HISTORY =
  /\b(first time|for the first time|all[- ]time (high|low)|record (high|low|close|closing)|highest (close |level )?since|lowest (close |level )?since|\d+[- ](year|month|week) (high|low)|never before|unprecedented)\b/i;

/**
 * Claims about history ("the first time the Dow closed above 50,000") cannot
 * be checked against one day of data, and the Nov 25 one was false (it first
 * closed above 50,000 on Nov 24). A recap that makes one is held for review.
 */
export function historyReasons(
  title: string,
  dek: string,
  html: string,
): string[] {
  const m = HISTORY.exec(`${title} ${dek} ${textOf(html)}`);
  return m ? [`Makes a historical claim ("${m[0]}") that is not checked`] : [];
}

const NUM = /(-?\$?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\$?\d+(?:\.\d+)?)(%?)/g;

/**
 * Every close or % change printed in prose within a few words of an
 * instrument's name must match its row (B-20: "Oil prices rose 3.3% to
 * $139.93"; real WTI was near $84). Only paragraphs and list items are read
 * (the tables are written from the data), each on its own. A span ends at the
 * next instrument or ticker, so "small caps (IWM) +0.60%" is IWM's figure, not
 * the Russell's. Points within 0.05%; percentages as precise as printed
 * ("0.27%" within half a hundredth). Round milestones ("above 50,000") and
 * years are not levels.
 */
export function figureReasons(html: string, rows: RecapRow[]): string[] {
  const paras = (
    sessionPart(html).match(/<(p|li)\b[^>]*>[\s\S]*?<\/\1>/gi) ?? []
  ).map(textOf);
  const out = new Set<string>();
  for (const text of paras) {
    for (const r of rows) {
      const ins = RECAP_INSTRUMENTS.find((i) => i.id === r.id)!;
      for (const m of text.matchAll(new RegExp(ins.words.source, "gi"))) {
        const after = text.slice(
          (m.index ?? 0) + m[0].length,
          (m.index ?? 0) + m[0].length + 70,
        );
        const stops = [
          ...RECAP_INSTRUMENTS.filter((o) => o.id !== r.id).map((o) =>
            after.search(o.words),
          ),
          after.search(/\(?\b(?!VIX\b|WTI\b|DJIA\b)[A-Z]{2,5}\b\)?/),
          after.search(/[.;]\s/),
        ].filter((i) => i >= 0);
        const span = stops.length ? after.slice(0, Math.min(...stops)) : after;
        for (const n of span.matchAll(NUM)) {
          const raw = n[1];
          const v = Number(raw.replace(/[$,]/g, ""));
          if (!Number.isFinite(v)) continue;
          if (n[2] === "%") {
            const dec = (raw.split(".")[1] ?? "").length;
            const tol = 0.5 * 10 ** -dec + 0.001;
            if (Math.abs(Math.abs(v) - Math.abs(r.pctChange)) > tol)
              out.add(
                `${r.label}: prose says ${raw}% but it moved ${fmtPct(r.pctChange)}`,
              );
            continue;
          }
          const isLevel =
            r.unit === "$"
              ? raw.includes("$")
              : Math.abs(v) >= 1000 ||
                (r.kind === "volatility" && /\.\d/.test(raw));
          if (!isLevel) continue;
          if (
            r.unit === "" &&
            (/^(19|20)\d{2}$/.test(raw) ||
              (Number.isInteger(v) && v % 1000 === 0))
          )
            continue;
          const okClose = Math.abs(v - r.close) / r.close <= 0.0005;
          const okChange =
            Math.abs(Math.abs(v) - Math.abs(r.change)) <=
            Math.max(0.01, Math.abs(r.change) * 0.0005);
          if (!okClose && !okChange)
            out.add(
              `${r.label}: prose says ${raw} but the close was ${fmtClose(r)}`,
            );
        }
      }
    }
  }
  return [...out];
}

// ── calendar ───────────────────────────────────────────────────────────────────

export interface CalendarEvent {
  name: string;
  /** ET calendar day, "2026-12-01". */
  day: string;
  importance: string;
  estimate: unknown;
  previous: unknown;
}

/**
 * The look-ahead calendar: real scheduled releases (FMP economic calendar
 * rows in macro_events) after the session day, soonest first. The FRED rows
 * in the same collection are observations, not releases: their ids are
 * series codes (PAYEMS, ICSA) and their dates are the period measured, which
 * is how "What to watch next" came to print raw codes on impossible dates
 * (B-26).
 */
const NOT_A_RELEASE = /\bCFTC\b|speculative net positions/i;

export function upcomingEvents(
  docs: Array<{ id: string; data: Record<string, unknown> }>,
  sessionDay: string,
  days = 10,
  max = 8,
): CalendarEvent[] {
  const end = new Date(`${sessionDay}T12:00:00Z`);
  end.setUTCDate(end.getUTCDate() + days);
  const last = end.toISOString().slice(0, 10);
  const rank = (s: string) => (s === "high" ? 0 : 1);
  return (
    docs
      .filter((d) => d.data.source === "fmp")
      .map((d) => ({
        name: String(d.data.name ?? "").trim(),
        day: String(d.data.eventDate ?? "").slice(0, 10),
        importance: String(d.data.importance ?? "medium").toLowerCase(),
        estimate: d.data.estimate ?? null,
        previous: d.data.previous ?? null,
      }))
      // Weekly positioning reports are not releases a reader watches for.
      .filter((e) => !NOT_A_RELEASE.test(e.name))
      .filter(
        (e) =>
          e.name &&
          /^\d{4}-\d{2}-\d{2}$/.test(e.day) &&
          e.day > sessionDay &&
          e.day <= last,
      )
      .sort((a, b) =>
        a.day === b.day
          ? rank(a.importance) - rank(b.importance)
          : a.day < b.day
            ? -1
            : 1,
      )
      .slice(0, max)
  );
}

function dayLabel(day: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${day}T12:00:00Z`));
}

const figure = (v: unknown) => (v == null || v === "" ? null : String(v));

/** The calendar timeline, written by code from the events (or a plain line when there are none). */
export function calendarHtml(events: CalendarEvent[]): string {
  if (!events.length)
    return `<div class="timeline">\n  <div class="timeline-item">\n    <div class="timeline-text">No major U.S. economic releases are scheduled in the next several days.</div>\n  </div>\n</div>`;
  const items = events.map((e) => {
    const est = figure(e.estimate);
    const prev = figure(e.previous);
    const extra = [
      est ? `consensus ${escapeHtml(est)}` : null,
      prev ? `prior ${escapeHtml(prev)}` : null,
    ]
      .filter(Boolean)
      .join(", ");
    return `  <div class="timeline-item${e.importance === "high" ? " flag" : ""}">\n    <div class="timeline-date">${dayLabel(e.day)}</div>\n    <div class="timeline-text">${escapeHtml(e.name)}${extra ? ` (${extra})` : ""}</div>\n  </div>`;
  });
  return `<div class="timeline">\n${items.join("\n")}\n</div>`;
}

/** Replaces the model's timeline under "What to watch next" with the code-built one. */
export function applyCalendar(html: string, events: CalendarEvent[]): string {
  return html.replace(
    /(<h2 id="calendar"[^>]*>[\s\S]*?)<div class="timeline">[\s\S]*?<\/div>\s*<\/div>\s*(?=<div class="warning">|<h2|$)/i,
    (_m, a: string) => `${a}${calendarHtml(events)}\n`,
  );
}

/** Raw series codes (the FRED doc ids) or dates outside the window left in the calendar. */
export function calendarReasons(
  html: string,
  seriesIds: string[],
  sessionDay: string,
): string[] {
  const m = /<h2 id="calendar"[\s\S]*?(?=<h2 id="takeaway"|$)/i.exec(html);
  if (!m) return [];
  const text = textOf(m[0]);
  const out: string[] = [];
  const raw = seriesIds.filter((id) =>
    new RegExp(`\\b${id.replace(/[^A-Za-z0-9]/g, "")}\\b`).test(text),
  );
  if (raw.length)
    out.push(`Calendar shows raw series codes: ${raw.join(", ")}`);
  for (const d of text.match(/\b\d{4}-\d{2}-\d{2}\b/g) ?? [])
    if (d <= sessionDay)
      out.push(`Calendar date ${d} is not after the session`);
  return out;
}

/** "Published Nov 25, 2026 · 4:47 PM ET · 10 min read" at the real publish time. */
export function readLine(at: Date, minutes: number): string {
  const day = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(at);
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: ET,
    hour: "numeric",
    minute: "2-digit",
  }).format(at);
  return `Published ${day} · ${time} ET · ${minutes} min read`;
}
