# Make Me Famous

A self-hosted LinkedIn studio for one person: write posts with Claude, schedule them, reply to comments and join other people's threads, all from one app. It posts through [Unipile](https://www.unipile.com) and runs on Vercel.

## What it does

- **Posts.** A board of Ideas, Ready and Scheduled. Each post can have photos, @tags of people or companies (with their photos and headlines as you type), and a first comment that goes up straight after the post.
- **Calendar.** Drop a post on a day and it takes that day's best time, worked out from when your own past posts did best.
- **Riff with Claude.** A writing partner beside the editor. It suggests 3 or 4 specific changes you can apply in one click, and rewrites on request, guided by a playbook of what works for you (`api/_playbook.ts`). It never invents facts.
- **Replies.** Unanswered comments on your posts from the last 7 days, each with a reply drafted in your voice.
- **Comments.** A rebuilt version of your feed, filtered to posts worth commenting on (30+ reactions by default, last 48 hours), with a comment drafted for each:
  - **Your circle.** Up to 150 people the app picks for you: people who react to and comment on your posts, people you've messaged on LinkedIn in the last 90 days, and anyone you add to "Always in your circle". Every 15 minutes it checks a couple of them for what they posted, liked or commented on, so you see the posts your circle is actually engaging with, tagged with who touched them. Remove anyone with one click.
  - **Popular in your sector.** The most engaged posts of the day from up to 5 LinkedIn industries you pick.
  - **Topics.** Keyword searches you set.
- **Learning loop.** Every comment you post is checked over the next 2 weeks: did it get likes or replies, and did the author engage back with you? A "What's working" table shows which people and sources pay off, and the app suggests people to add based on who engages with you.
- **Results.** Impressions, reactions, comments and reposts on what you've published, with medians and splits by weekday and by whether the post had a photo.

Nothing goes to LinkedIn without you: scheduled posts go out only when you've scheduled them, and every reply, comment and reaction goes out only when you click to send it. A cron job checks every 5 minutes and publishes at most one due post per run.

## What you need

- A [Vercel](https://vercel.com) Pro account, with a Blob store for the app's data. The free Hobby plan only allows daily cron jobs, so the 5-minute publisher won't deploy there; on Hobby, change the schedule in `vercel.json` to once a day and posts go out at most daily.
- A [Unipile](https://www.unipile.com) account with your LinkedIn connected (paid, with a free trial).
- An [Anthropic](https://console.anthropic.com) API key for the Claude features.

## Set it up

1. Fork this repo and import it into Vercel.
2. In the Vercel project, add a Blob store (Storage > Create > Blob). That sets `BLOB_READ_WRITE_TOKEN` for you.
3. Add these environment variables:

   | Variable | What it is |
   |---|---|
   | `APP_PASSWORD` | The password you'll log in with. It's the only thing guarding your LinkedIn, so make it long and random |
   | `UNIPILE_DSN` | Your Unipile API address, from the Unipile dashboard |
   | `UNIPILE_API_KEY` | Your Unipile API key |
   | `UNIPILE_ACCOUNT_ID` | The Unipile id of your connected LinkedIn account |
   | `ANTHROPIC_API_KEY_MAKE_ME_FAMOUS` | Your Anthropic API key |
   | `CRON_SECRET` | Any long random string; Vercel's cron sends it so only the cron can trigger publishing |
   | `AUTHOR_NAME` | Your name, so Claude writes as you |
   | `AUTHOR_ABOUT` | One line on who you are, e.g. "a product designer in Berlin who writes about onboarding" |
   | `MENTIONS_LIVE` | Set to `1` to turn on @tagging in published posts |

4. Deploy, open the site and log in.
5. Rewrite `api/_playbook.ts` with what works on your LinkedIn, and set your name and headline in the app so the previews look like you.

To run it locally: `npm install`, then `vercel dev` from the Vercel CLI (so the API routes run too) with the same variables in `.env.local`.

## Run it from a terminal

`tools/mplm.py` drives the app's API, so you (or Claude Code) can manage posts without opening it:

```
export MPLM_URL=https://your-app.vercel.app
python3 tools/mplm.py list
python3 tools/mplm.py add --title "Hiring post" --text-file draft.txt
python3 tools/mplm.py schedule ID "2026-12-01 08:30"
```

It reads `APP_PASSWORD` from a `.env` file in the repo root (not `.env.local`). `python3 tools/mplm.py --help` lists everything. `tools/refresh-calendar.sh` builds a one-page review board of your drafts and schedule in `.calendar/` (ignored by git). Viewing works anywhere; the editing and feedback features only work when the page is published as a Claude artifact.

## Know before you use it

- **LinkedIn's terms restrict automated activity.** Unipile acts as your logged-in account, and everything here waits for you to press send, but you're still the one accountable for what goes out.
- **Times are London time.** The best-time maths and scheduling assume Europe/London (`MPLM_TZ` changes it for the CLI only).
- **One user per deployment.** There are no accounts, just the password.
