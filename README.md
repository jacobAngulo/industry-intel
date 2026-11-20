# Industry Intel

Industry Intel is a private news site. Each feed has a profile that describes the work that it follows, and the site shows only the developments that can change that work. For each story it says what changed, why it matters to the feed, and what to do next. A deeper technical analysis with suggested actions is one click away.

There is no login. Everybody who can open the site can read and change everything. A display name (asked one time) shows who added or changed what.

## What the app does

- **Feeds.** Each feed has its own purpose, project context, sources, topics, exclusions, relevance priorities, brief format, digest schedule, quiet hours, and alert rule. The first run creates three feeds: Agentic Development, Internal AI Platform, and Industry Radar.
- **One shared source directory.** You add a source one time and use it in many feeds. Each feed has its own Follow and Ignore text and priority for the source. Source types: X users, X keywords, podcasts, engineering blogs, GitHub repositories, documentation and changelog pages, newsletters, YouTube, communities (Hacker News, Reddit, Discourse forums), research (arXiv, OpenAlex), and saved web searches.
- **Add a source** in four steps: paste a link, enter a sender, or describe a topic (several entries are possible, one on each line) → choose what matters → preview the recent items and see which ones would enter each feed → add.
- **Judging.** The worker reads the sources. The model judges each new item one time for all feeds that use its source. Items about one event become one story. The rank is plain code: the relevance, the topic and source priorities, the feedback of the team, and the age of the story. "Why this ranks here" on each story shows every part.
- **Feedback** on each story: Useful, Too basic, Off topic, Already knew this. Votes change the rank at once, and they teach the judge what the team wants.
- **Digests and alerts** in the app: a digest page for each period, and an alert mark for a story that matches the alert rule of a feed.

The full behavior is in [docs/specification.md](docs/specification.md).

## Requirements

- Node.js 20.12 or later (tested with 20.20.0), and npm.
- An Ollama cloud API key. The model judges each item and writes the analyses. Without the key, the worker still reads the sources, but no story shows.
- Optional: an X API Bearer Token with credits, for X users and X keywords.

## Set up

1. Install the packages:

```bash
npm install
```

2. Create the settings file. Skip this step when `.env` exists already:

```bash
cp .env.example .env
```

3. Manual step: open `.env` in a text editor and set `OLLAMA_API_KEY`. Create the key on the Ollama web site (Settings > Keys).
4. Optional manual step for X: set `X_BEARER_TOKEN` in `.env`. Then open the X Developer Console, add credits, and set a spending limit. X bills each post that the app reads (about $0.005 for each post). Without credits, the X sources show the error "The X API account has no credits left".

Git ignores `.env`. Never commit it.

## Run the app

Start the web app and the worker together (development mode):

```bash
npm run dev
```

Open http://localhost:4400 in your browser.

Stop the app with Ctrl+C in the same terminal.

For production mode, build the app first:

```bash
npm run build
```

Then start the web app and the worker together:

```bash
npm start
```

The default port is 4400. To use a different port, set it in the shell:

```bash
PORT=4500 npm run dev
```

The web process and the worker share one SQLite file: `data/app.db`. The first start creates it, with the three feeds and the three sources that the team named (@chamath, the All-In podcast, and the Microsoft Foundry "What's new" page).

## First steps in the app

1. Click **Set your name** at the top right and enter your name.
2. Open **Settings** and fill in the shared feed profile: focus and requirements. In each feed, fill in the context on the Feed Profile tab. The judge reads the profiles for each item.
3. Open a feed. If it has few sources, the page offers starter sources (GitHub releases of coding agents, vendor changelogs, engineering blogs). Click **Add** on the ones that you want.
4. Open **Sources** and click **Add source** to add your own sources.
5. Open **Status** to see the worker, the model, the usage of the day, and the sources with errors.

The worker checks new sources within a minute. The first stories show a few minutes later.

## Settings in `.env`

| Variable | Purpose | Default |
|---|---|---|
| `OLLAMA_API_KEY` | The Ollama cloud key. Necessary. | — |
| `X_BEARER_TOKEN` | The X API token. Optional. | — |
| `X_MAX_POSTS_PER_DAY` | Hard stop for X post reads in one UTC day. | 300 |
| `LLM_MAX_CALLS_PER_DAY` | Hard stop for model calls in one UTC day. | 1500 |
| `WEB_SEARCH_MAX_PER_DAY` | Hard stop for web searches in one UTC day. | 50 |
| `OLLAMA_MODEL_JUDGE`, `OLLAMA_MODEL_ANALYSIS` (and the `_FALLBACK` variables) | Model names. | see `docs/specification.md` §20 |
| `GITHUB_TOKEN` | Only GitHub discussions need it. | — |
| `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` | Only when Reddit refuses requests without a login. | — |
| `IMAP_HOST`, `IMAP_PORT`, `IMAP_USER`, `IMAP_PASSWORD`, `IMAP_MAILBOX` | A dedicated mailbox for newsletters that have no feed. The app only reads it. | — |
| `DATABASE_PATH` | The SQLite file. | `./data/app.db` |

A variable that is set in the shell wins over `.env`. A change in `.env` needs a restart of the app.

## Commands

| Command | Result |
|---|---|
| `npm run dev` | Start the web app and the worker in development mode. |
| `npm run build` | Build the web app for production. |
| `npm start` | Start the production web app and the worker. |
| `npm run dev:web`, `npm run dev:worker` | Start only one of the two processes. |
| `npm test` | Run the tests. No test uses the network or a real key. |
| `npm run typecheck` | Run the TypeScript check. |
| `npm run lint` | Run ESLint. |

## Data

- Back up the database while the app runs:

```bash
sqlite3 data/app.db ".backup data/app-backup.db"
```

- Start again with an empty database: stop the app, then delete the database files:

```bash
rm -f data/app.db data/app.db-wal data/app.db-shm
```

The next start creates the three feeds and the three sources again.

## Look at the app with demo data

The demo script fills a separate database with invented stories, sources, votes, analyses, and digests. It never touches `data/app.db`.

1. Create the demo database:

```bash
DATABASE_PATH=/tmp/industry-intel-demo.db npx tsx scripts/demo-data.ts
```

2. Start only the web app on that database, with no keys, so that nothing calls X or the model:

```bash
DATABASE_PATH=/tmp/industry-intel-demo.db OLLAMA_API_KEY= X_BEARER_TOKEN= npm run dev:web
```

3. Open http://localhost:4400. The banner "The worker is not running" is expected here.

## How it works

1. **Check.** The worker asks each source that is due for new items (each source type has its own interval). A source that fails waits longer after each failure.
2. **Store.** New items get a status. Old items, items over the first-run limit, and items of sources that are in no feed are stored but not judged. An item that links to a story of another source joins that story with no model call.
3. **Judge.** One model call for each new item gives the facts of the item (a calm headline, what changed, the names) and one judgement for each feed that uses the source: relevance 0–100, the reason, why it matters, a suggested action, topics, an exclusion match, and an alert flag. The call also decides if the item is about a story that exists already.
4. **Rank.** Plain code computes the score of each story in each feed and the reason when a story is hidden (below the minimum relevance, an exclusion, a muted topic, low substance, or team feedback).
5. **Analyze.** A person can ask for the deeper analysis of a story. The worker reads the sources in full and writes it with a stronger model.
6. **Digests.** At the digest time of a feed, the worker stores a snapshot of the top stories of the period.

All model calls go to the Ollama cloud API. The model never runs tools, and the app treats the text of the sources as data, never as instructions.

## Troubleshooting

- **"The worker is not running"**: start the app with `npm run dev` or `npm start` (they start the worker too). Only one worker runs at a time; a second one stops by itself.
- **An X source shows "The X API account has no credits left"**: add credits in the X Developer Console, then click **Check now** on the source page. The X token can be valid while the account has no credits: the X API then answers `402 credits depleted`.
- **"The model is not available now"**: the model service refused calls (limit, overload, or a bad key). The worker pauses and tries again later. Open **Status** for the reason.
- **"The model call limit for today is used"**: raise `LLM_MAX_CALLS_PER_DAY` in `.env` and restart, or wait for the next UTC day.
- **Port 4400 is busy**: start with a different port, for example `PORT=4500 npm run dev`.
