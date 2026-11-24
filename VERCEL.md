# Live View Counter: website version (Vercel)

This is the version of the counter that runs as a public website on Vercel. Visitors see your counters; only you can change them, after signing in with your own password.

How it differs from the copy on your PC:

- **Official numbers only.** YouTube counters show your channel's official statistics from the YouTube Data API, checked about once a minute. There's no estimated "live" count, pace, chart or goal bar for YouTube, because YouTube's API rules don't allow showing independently calculated figures to the public.
- **YouTube, Bluesky and Instagram only.** TikTok, Twitch and Kick aren't offered on the website, because they have no official API for this and their terms don't allow reading their pages automatically.
- **Privacy built in.** Privacy policy, terms and cookie policy pages, a privacy choices banner (fonts from Google and Vercel Web Analytics only run if a visitor allows them), and nothing personal stored about visitors.

## What's in this folder

| Path | What it is |
| --- | --- |
| `public/` | The pages, styles and scripts visitors download, plus `privacy.html`, `terms.html` and `cookies.html` |
| `api/index.js` | The server part: one Vercel Function that answers every `/api/...` request |
| `src/` | Shared code for reading YouTube, Bluesky and Instagram, and talking to the database |
| `vercel.json` | Vercel settings: where the pages are, the London region, and security headers |
| `package.json` | Tells Vercel this is a Node.js project. There's nothing to install. |

## Put it online

You need a free [Vercel](https://vercel.com) account. Vercel's free **Hobby** plan is for personal, non-commercial use only. If the site is for a business or makes money, use the **Pro** plan.

### 1. Upload the files

Pick one:

- **With GitHub (no command line):** create a new private repository on GitHub, choose **Add file → Upload files**, and drag in everything from this folder (keep the folders). Then in Vercel: **Add New… → Project**, import that repository, leave **Framework Preset** on **Other**, and click **Deploy**.
- **With the Vercel command line:** open a terminal in this folder and run `npx vercel`, answer the questions (accept the defaults), then run `npx vercel --prod`.

The first deployment works, but the site can't save anything until the next two steps are done.

### 2. Connect a database

In your Vercel project, open **Storage**, choose **Upstash** (Redis) from the marketplace, create a free database in a region in Europe, and connect it to this project. Vercel adds the database's address and password to the project for you. The site looks for `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, with or without a prefix.

### 3. Add your settings

In the project, open **Settings → Environment Variables** and add:

| Name | Needed? | What to put |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Yes | The password you'll use to sign in. At least 12 characters; a long random one is best. Don't reuse a password from anywhere else. |
| `OWNER_NAME` | Strongly recommended | Your name or your business's name. The privacy policy, terms and cookie policy show it as the person running the site. UK data protection law expects that to be stated. |
| `YOUTUBE_API_KEY` | Optional | A YouTube Data API key. If you leave it out, you paste the key on the setup page instead and it's kept in the database. |
| `SESSION_SECRET` | Optional | Any long random text. Changing it signs you out everywhere. Without it, sign-ins are tied to `ADMIN_PASSWORD`. |

Then redeploy so the settings take effect: **Deployments → ⋯ next to the latest one → Redeploy**.

**Use a separate YouTube API key for the website.** The copy on your PC uses most of its key's free daily allowance by design, so sharing that key would leave the website short. Create a second Google Cloud project with its own key: [create a project](https://console.cloud.google.com/projectcreate), [enable YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) for it, then [Credentials](https://console.cloud.google.com/apis/credentials) → **Create credentials** → **API key**, and restrict the key to **YouTube Data API v3**. (The setup page on the site shows these steps too.) The website uses at most about 1,440 of the 10,000 free units a day.

### 4. Set up the counter

1. Open your site and click **Owner sign-in** at the bottom. Enter your `ADMIN_PASSWORD`.
2. Enter your channel, paste your API key (unless you set `YOUTUBE_API_KEY`), tick the box to agree to the terms, and click **Start counting**.
3. Press `S` (or the gear icon) to add Bluesky or Instagram counters and change the look. Changes are saved straight away, and visitors see them within about a minute.
4. Click **Sign out** at the bottom when you're done. The sign-in lasts 7 days otherwise.

### 5. Optional: visit counting

To see how many people visit: in Vercel open **Analytics** and enable **Web Analytics**, then on your site go to **Settings → App → Website** and turn on **Offer visitors Vercel Web Analytics**. Visitors are then asked first, and it only runs for those who say yes.

### 6. Optional: your own domain

In Vercel: **Settings → Domains**. HTTPS is set up automatically.

## For OBS

Add a *Browser* source with your site's address followed by `/?overlay` (for example `https://your-site.vercel.app/?overlay`). The same extras as on your PC work, such as `&counter=<id>`, `&layout=grid` and `&bg=show` (Settings → Stream builds the address).

## Free plan limits

- **Upstash:** the free database allows 500,000 commands a month. With visitors around the clock the site uses roughly 300,000; with fewer visitors, less, because it only checks the platforms while someone is looking. You can see usage in the Upstash dashboard.
- **Vercel Hobby:** shared numbers are cached on Vercel's network for 30 seconds, so lots of visitors cost about the same as one.
- **Uploads:** a background picture up to 3 MB and a tick sound up to 2 MB.

## Before you share the link

- Set `OWNER_NAME`, so the legal pages say who runs the site.
- Only add accounts that are yours or that you have permission to show.
- If the site is for a business: use Vercel Pro, and the UK's E-Commerce Regulations also require your business name, a geographic (postal) address and your email on the site, plus your company and VAT numbers if you have them. Add those to the footer and legal pages.
- Check whether you need to pay the ICO's data protection fee: the ICO has a short self-assessment on its website. Many small non-commercial sites are exempt, but check.
- Keep the promises in the privacy policy: reply to privacy requests within one month, acknowledge complaints within 30 days, and delete old emails within 12 months.
- If you change what the site collects or which services it uses, update the policies and their dates.

This guide and the legal pages are a careful starting point, not legal advice. If the site becomes a business, it's worth having a solicitor look over them.
