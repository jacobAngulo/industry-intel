# Industry Intel: product requirements

Status: version 1 is built. Last updated: 2026-11-22.

This document says what the product does, for whom, and why. [specification.md](specification.md) says exactly how it behaves. The references such as "§8" point to sections of that file.

## Summary

Industry Intel is a private news site for a software engineering team. It reads the sources that the team chooses and shows only the developments that can change the work of the team. For each story it says what changed, why it matters, and what to do next.

## Problem

Engineers who build with agents must follow many places: vendor changelogs, GitHub releases, blogs, podcasts, X, and forums. Three things make this difficult:

- Most of the content is not about the work of the team. Launch hype, funding news, and beginner tutorials hide the important changes.
- The same event shows up in many places.
- A headline does not say if the team must act.

## Users

The product is for software engineers who build projects with agentic development for internal teams, and who build an in-house AI app for their organization.

| Role | What this person does |
|---|---|
| Reader | Reads the feeds and digests, votes on stories, and asks for a deeper analysis. |
| Source owner | A reader who is named on a source and maintains its settings. |
| Administrator | A reader who can also change the API keys and delete a feed. |
| Operator | Runs the app and approves or denies access requests. |

Every approved person can read and change everything, except the two administrator actions. "Source owner" is a name on a source, not a permission.

## Goals

1. Show the developments that matter to the team, and hide the rest.
2. Say for each story what changed, why it matters to this feed, and what to do.
3. Let the team manage sources and relevance in the app, with no code change.
4. Show why each story ranks where it does, and why a story is hidden.
5. Keep the use of paid services below fixed daily limits.

## Success measures

No target is set yet. The app already records the data for these measures:

| Measure | Definition | Target |
|---|---|---|
| Useful stories | For each source: stories with more "Useful" votes than "Off topic" and "Too basic" votes together | Not set |
| Signal rate | For each source, 30 days: items shown ÷ items judged | Not set |
| Vote mix | Votes by reason | Not set |
| Noise | Unresolved "noisy" flags, and sources with the hint "Low signal" | Not set |
| Cost | Model calls, X post reads, and web searches each day | Below the daily limits |

The app does not record page views or the number of active readers.

## Requirements

### Feeds

- **F1.** The app has several shared feeds. Each feed has its own purpose, context, sources, topics, exclusions, brief format, and delivery settings. (§4.8)
- **F2.** The first run creates three feeds: Agentic Development, Internal AI Platform, and Industry Radar. (§12)
- **F3.** A shared feed profile (focus and requirements) gives context to every feed. (§4.8)
- **F4.** A person can create, archive, and restore a feed. (§4.8, §4.9)

### Sources

- **S1.** One shared directory holds all sources. A person adds a source once and uses it in many feeds. Each feed has its own "Follow" text, "Ignore" text, and priority for the source. (§4.5, §4.6)
- **S2.** The app supports 11 source types: X users, X keywords, podcasts, engineering blogs, GitHub repositories, documentation and changelog pages, newsletters, YouTube, communities, research, and web searches. (§6)
- **S3.** A person adds a source in four steps: describe it, choose what matters, preview the recent items, and add it. The preview shows which items would enter each selected feed. (§4.7)
- **S4.** A person can add several sources of one type at once, one on each line. (§4.5, §4.7)
- **S5.** Each source shows who added it, why it matters, its filters, its last successful check, and its count of useful stories. (§4.6)
- **S6.** Anyone can flag a source as noisy. The app gives a hint when a source has a low signal or fails. (§10)

### Stories and relevance

- **R1.** The app groups items about the same event into one story. (§7)
- **R2.** The model judges each new item against each feed that uses the source. It gives the relevance (0–100), the reason, why it matters, and a suggested action. (§7.3)
- **R3.** The ranking is plain code. The inputs are the relevance, the priorities of the feed, the votes of the team, the sources of the story, and its age. (§8)
- **R4.** Each story has "Why this ranks here", which lists every part of the rank. (§8.3)
- **R5.** A person can see the filtered stories, each with its reason. A "Useful" vote can bring a story back, unless its topic is muted or its source left the feed. (§4.1, §8.1)
- **R6.** Each feed sets its topic priorities, exclusions, relevance priorities, minimum relevance, and freshness. (§4.8)

### Briefs and analysis

- **B1.** Each story has a brief: a headline, what changed, why it matters, and a suggested action. (§4.1)
- **B2.** Each feed sets its summary length and technical depth, and turns suggested actions on or off. (§9.1)
- **B3.** A person can ask for a deeper technical analysis of a story. It gives the details, the implications, the risks, the actions, the open questions, and the sources used. (§7.5)

### Feedback

- **K1.** Each story has four votes: Useful, Too basic, Off topic, and Already knew this. Each person has one vote for each story in each feed. (§4.3)
- **K2.** A vote changes the rank at once and gives hints to later judgements. (§8.5)
- **K3.** One person cannot hide a story for the team. A hide for everybody needs two negative votes for the same reason, and more of them than "Useful" votes. (§8.1)

### Digests and alerts

- **D1.** Each feed can have a daily, weekday, or weekly digest at a chosen time. A digest is a stored snapshot in the app. (§9.2)
- **D2.** Each feed can have an alert rule. A story that matches the rule gets an alert mark in the app. Quiet hours delay the mark. (§9.3)

### Access and administration

- **A1.** A person signs in with Google and sends an access request. The operator approves or denies it. A person with no approval sees no content. (§15)
- **A2.** Only an administrator can change the API keys or delete a feed. The app never shows a saved key again. (§4.9)
- **A3.** An activity page shows who changed the sources, the feeds, and the shared settings. (§4.10)
- **A4.** A status page shows the worker, the queues, the model, the use of the day, and the sources with errors. (§4.10)
- **A5.** Each page has a "Send feedback" button that adds a ticket to the project backlog.

### Quality

- **Q1.** The app treats source text and model output as data. The model runs no tools, and links from the model must come from an allowed list. (§14)
- **Q2.** The app sends no secret to the browser, the logs, or the error messages. (§14)
- **Q3.** When the model is not available, the worker keeps the waiting items and tries again. The pages say what is wrong. (§7.3, §13)
- **Q4.** The pages work at phone width, with the keyboard, and in light and dark themes. (§15)

## Limits

| Limit | Default |
|---|---|
| Model calls each day | 1,500 |
| X posts read each day | 300 (about $1.50 at $0.005 for each post) |
| Web searches each day | 50 |
| Sources | 500 |
| Feeds | 30 |

The operator can change the three daily limits. A day is one UTC day.

## Out of scope for version 1

- Email and chat delivery
- Transcription of podcast audio (the app uses a published transcript when there is one)
- YouTube captions
- Story search
- More than one team
- Permissions for each feed or each source
- Copying settings between feeds
- Lobsters as a community source

## Dependencies

| Service | Need | Without it |
|---|---|---|
| Google sign-in | Required | No page with content opens. |
| Ollama cloud API | Required | The app reads the sources, but judges no items. |
| X API with credits | Optional | X sources do not update. |
| Newsletter mailbox | Optional | Newsletters with no feed do not update. |
| GitHub token | Optional | GitHub discussions do not update. |
| Reddit credentials | Optional | Reddit sources fail if Reddit refuses requests without a login. |

## Risks

| Risk | Response |
|---|---|
| The model gives a wrong score or a wrong fact. | The story shows its sources and reason. Filtered stories stay visible on request. Votes correct the rank. |
| A small team gives few votes, so the feeds learn slowly. | Topics, exclusions, and priorities work with no votes. |
| X costs grow. | A daily limit stops the reads. The add-source flow shows the cost. |
| A site blocks or changes its feed. | The source shows its error. The worker waits longer after each failure. |
| A source contains text that tries to control the model. | The text is marked as data, and the app validates the model output. |
| A podcast has no transcript. | The story says "From the show notes only", and its relevance is 69 at most. |

## Open questions

1. What is the target for each success measure?
2. How many people will use the app, and how many must use it each week for it to be a success?
3. Must the app record active readers? Without this, weekly use cannot be measured.
4. How long must the app keep stories, votes, and analyses?
5. What comes after version 1? No roadmap exists.
