// Renders assets for the profile README from live GitHub data.
// No dependencies — Node 20+ (global fetch). Output: dist/stats-{dark,light}.svg
//
// Publishes to the `output` branch, so main stays free of generated-asset commits.

const TOKEN = process.env.GITHUB_TOKEN;
const LOGIN = process.env.LOGIN || "lblogan14";
const OUT = "dist";

if (!TOKEN) {
  console.error("GITHUB_TOKEN is required");
  process.exit(1);
}

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats",
    },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`GraphQL HTTP ${res.status}: ${await res.text()}`);
  const json = await res.json();
  if (json.errors) throw new Error(`GraphQL: ${JSON.stringify(json.errors)}`);
  return json.data;
}

const PROFILE = `
  query ($login: String!) {
    user(login: $login) {
      createdAt
      repositories(privacy: PUBLIC, ownerAffiliations: OWNER, isFork: false) {
        totalCount
      }
    }
  }
`;

const CALENDAR = `
  query ($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        contributionCalendar {
          weeks { contributionDays { date contributionCount } }
        }
      }
    }
  }
`;

// GitHub caps contributionsCollection at one year per query, so walk year by year.
async function allContributionDays(createdAt) {
  const days = new Map();
  const start = new Date(createdAt);
  const now = new Date();
  let from = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));

  while (from <= now) {
    const to = new Date(from);
    to.setUTCFullYear(to.getUTCFullYear() + 1);
    const capped = to > now ? now : to;

    const data = await gql(CALENDAR, {
      login: LOGIN,
      from: from.toISOString(),
      to: capped.toISOString(),
    });

    for (const week of data.user.contributionsCollection.contributionCalendar.weeks) {
      for (const d of week.contributionDays) days.set(d.date, d.contributionCount);
    }
    from = to;
  }

  return [...days.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function streaks(days) {
  let longest = 0, longestRange = null;
  let run = 0, runStart = null;

  for (const d of days) {
    if (d.count > 0) {
      if (run === 0) runStart = d.date;
      run++;
      if (run > longest) { longest = run; longestRange = [runStart, d.date]; }
    } else {
      run = 0;
    }
  }

  // Current streak: walk backwards. A zero-contribution today is a grace day,
  // not a broken streak — the day isn't over yet.
  let current = 0, currentRange = null;
  let i = days.length - 1;
  if (i >= 0 && days[i].count === 0) i--;
  const endIdx = i;
  while (i >= 0 && days[i].count > 0) { current++; i--; }
  if (current > 0) currentRange = [days[i + 1].date, days[endIdx].date];

  return { longest, longestRange, current, currentRange };
}

const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const pretty = (iso) => {
  const [y, m, d] = iso.split("-");
  return `${MONTHS[+m - 1]} ${+d}, ${y}`;
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function render(tiles, updated, theme) {
  const dark = theme === "dark";
  const bg = dark ? "#0B0B0C" : "#FBF8F3";
  const fg = dark ? "#E8E0D0" : "#0B0B0C";
  const rule = dark ? "#E8E0D0" : "#0B0B0C";
  const ruleOp = dark ? "0.12" : "0.14";
  const subOp = dark ? "0.38" : "0.45";
  const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const sans = "Inter, 'Helvetica Neue', Arial, sans-serif";
  const step = 1000 / tiles.length;

  const body = tiles.map((t, i) => {
    const x = Math.round(step * i + step / 2);
    const divider = i === 0 ? "" :
      `<line x1="${Math.round(step * i)}" y1="34" x2="${Math.round(step * i)}" y2="116" stroke="${rule}" stroke-opacity="${ruleOp}"/>`;
    return `${divider}
    <text x="${x}" y="70" font-family="${sans}" font-size="42" font-weight="700" fill="${fg}">${esc(t.big)}</text>
    <text x="${x}" y="98" font-size="11" letter-spacing="2.5" fill="#E4002B">${esc(t.label)}</text>
    <text x="${x}" y="118" font-size="9.5" letter-spacing="1.5" fill="${fg}" opacity="${subOp}">${esc(t.sub)}</text>`;
  }).join("\n");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1000" height="150" viewBox="0 0 1000 150" role="img" aria-label="${esc(tiles.map(t => `${t.big} ${t.label}`).join(", "))}">
  <rect width="1000" height="150" fill="${bg}"/>
  <rect x="0" y="0" width="1000" height="2" fill="#E4002B" opacity="0.85"/>
  <g text-anchor="middle" font-family="${mono}">
${body}
  </g>
  <text x="990" y="142" text-anchor="end" font-family="${mono}" font-size="8" letter-spacing="1.5" fill="${fg}" opacity="0.28">UPDATED ${esc(updated)}</text>
</svg>
`;
}

const { mkdir, writeFile } = await import("node:fs/promises");

const profile = await gql(PROFILE, { login: LOGIN });
const days = await allContributionDays(profile.user.createdAt);
const total = days.reduce((n, d) => n + d.count, 0);
const { longest, longestRange, current, currentRange } = streaks(days);
const since = pretty(days[0]?.date ?? profile.user.createdAt.slice(0, 10));

const tiles = [
  { big: total.toLocaleString("en-US"), label: "CONTRIBUTIONS", sub: `SINCE ${since.toUpperCase()}` },
  { big: String(current), label: "CURRENT STREAK", sub: currentRange ? `${pretty(currentRange[0])} —`.toUpperCase() : "DAYS" },
  { big: String(longest), label: "LONGEST STREAK", sub: longestRange ? `${pretty(longestRange[0])} — ${pretty(longestRange[1])}`.toUpperCase() : "DAYS" },
  { big: String(profile.user.repositories.totalCount), label: "REPOS", sub: "PUBLIC, NON-FORK" },
];

const updated = new Date().toISOString().slice(0, 10);
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/stats-dark.svg`, render(tiles, updated, "dark"));
await writeFile(`${OUT}/stats-light.svg`, render(tiles, updated, "light"));

console.log(`stats: ${total} contributions, current ${current}, longest ${longest}, ${profile.user.repositories.totalCount} repos`);
