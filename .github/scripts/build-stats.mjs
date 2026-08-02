// Renders assets for the profile README from live GitHub data.
// No dependencies — Node 20+ (global fetch). Output: dist/stats-{dark,light}.svg
//
// Publishes to the `output` branch, so main stays free of generated-asset commits.
//
// TOKENS
//   GITHUB_TOKEN  — the Actions default. Sees public data only.
//   PROFILE_TOKEN — optional classic PAT with `repo` + `read:user`. Adds private
//                   repos and private contributions. Tried first; if it is missing,
//                   expired, or rejected, this falls back to GITHUB_TOKEN so the
//                   README degrades to public-only numbers instead of breaking.

const LOGIN = process.env.LOGIN || "lblogan14";
const OUT = "dist";

async function graphql(token, query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${token}`,
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

// Pick the first token that actually authenticates.
const candidates = [
  ["PROFILE_TOKEN", process.env.PROFILE_TOKEN],
  ["GITHUB_TOKEN", process.env.GITHUB_TOKEN],
].filter(([, v]) => v);

let TOKEN = null;
for (const [name, value] of candidates) {
  try {
    const who = await graphql(value, `query { viewer { login } }`);
    TOKEN = value;
    console.log(`auth: using ${name} (viewer: ${who.viewer.login})`);
    break;
  } catch (err) {
    console.warn(`auth: ${name} rejected — ${err.message.split("\n")[0]}`);
  }
}
if (!TOKEN) {
  console.error("No usable token. Set GITHUB_TOKEN (and optionally PROFILE_TOKEN).");
  process.exit(1);
}

const gql = (query, variables) => graphql(TOKEN, query, variables);

const PROFILE = `
  query ($login: String!) {
    user(login: $login) {
      createdAt
      allRepos: repositories(ownerAffiliations: OWNER, isFork: false) { totalCount }
      publicRepos: repositories(ownerAffiliations: OWNER, isFork: false, privacy: PUBLIC) { totalCount }
    }
  }
`;

const CALENDAR = `
  query ($login: String!, $from: DateTime!, $to: DateTime!) {
    user(login: $login) {
      contributionsCollection(from: $from, to: $to) {
        restrictedContributionsCount
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
  let restricted = 0;
  const start = new Date(createdAt);
  const now = new Date();
  let from = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));

  while (from <= now) {
    const to = new Date(from);
    to.setUTCFullYear(to.getUTCFullYear() + 1);
    const capped = to > now ? now : to;

    const { contributionsCollection: cc } = (await gql(CALENDAR, {
      login: LOGIN,
      from: from.toISOString(),
      to: capped.toISOString(),
    })).user;

    restricted += cc.restrictedContributionsCount;
    for (const week of cc.contributionCalendar.weeks) {
      for (const d of week.contributionDays) days.set(d.date, d.contributionCount);
    }
    from = to;
  }

  const sorted = [...days.entries()]
    .map(([date, count]) => ({ date, count }))
    .sort((a, b) => a.date.localeCompare(b.date));
  return { days: sorted, restricted };
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
  const ruleOp = dark ? "0.12" : "0.14";
  const subOp = dark ? "0.38" : "0.45";
  const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const sans = "Inter, 'Helvetica Neue', Arial, sans-serif";
  const step = 1000 / tiles.length;

  const body = tiles.map((t, i) => {
    const x = Math.round(step * i + step / 2);
    const divider = i === 0 ? "" :
      `<line x1="${Math.round(step * i)}" y1="34" x2="${Math.round(step * i)}" y2="116" stroke="${fg}" stroke-opacity="${ruleOp}"/>`;
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

const { user } = await gql(PROFILE, { login: LOGIN });
const { days, restricted } = await allContributionDays(user.createdAt);

const total = days.reduce((n, d) => n + d.count, 0);
const { longest, longestRange, current, currentRange } = streaks(days);
const since = (days[0]?.date ?? user.createdAt).slice(0, 4);

// Rolling 365 days — the same window GitHub's own profile graph uses, so the
// strip is directly comparable to the graph sitting right below it.
const cutoff = new Date();
cutoff.setUTCDate(cutoff.getUTCDate() - 364);
const cutoffISO = cutoff.toISOString().slice(0, 10);
const lastYear = days
  .filter((d) => d.date >= cutoffISO)
  .reduce((n, d) => n + d.count, 0);

const allRepos = user.allRepos.totalCount;
const publicRepos = user.publicRepos.totalCount;
const privateRepos = allRepos - publicRepos;
const seesPrivate = privateRepos > 0;

// `restricted` counts private contributions the token is NOT allowed to itemise.
// They are already inside totalContributions, so never add them on top.
console.log(
  `stats: ${total} all-time, ${lastYear} last 365d, ` +
  `current streak ${current}, longest ${longest}, ` +
  `${allRepos} repos (${publicRepos} public / ${privateRepos} private)`
);
if (!seesPrivate) {
  console.log("note: token cannot see private repos — add PROFILE_TOKEN (classic PAT, `repo` scope).");
}
if (restricted === 0 && privateRepos > 0) {
  console.log(
    "note: private CONTRIBUTIONS look excluded. A token cannot fix this on its own — " +
    "enable Settings > Public profile > 'Include private contributions on my profile'."
  );
}

const tiles = [
  {
    big: total.toLocaleString("en-US"),
    label: "CONTRIBUTIONS",
    sub: `ALL TIME · SINCE ${since}`,
  },
  {
    big: lastYear.toLocaleString("en-US"),
    label: "LAST 12 MONTHS",
    sub: "ROLLING 365 DAYS",
  },
  {
    big: String(longest),
    label: "LONGEST STREAK",
    sub: longestRange ? `${pretty(longestRange[0])} — ${pretty(longestRange[1])}`.toUpperCase() : "DAYS",
  },
  {
    big: String(allRepos),
    label: "REPOS",
    sub: seesPrivate ? `${publicRepos} PUBLIC · ${privateRepos} PRIVATE` : "PUBLIC, NON-FORK",
  },
];

const updated = new Date().toISOString().slice(0, 10);
await mkdir(OUT, { recursive: true });
await writeFile(`${OUT}/stats-dark.svg`, render(tiles, updated, "dark"));
await writeFile(`${OUT}/stats-light.svg`, render(tiles, updated, "light"));
