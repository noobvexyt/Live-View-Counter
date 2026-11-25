# Live View Counter: website version (Vercel)

This is the version of the counter that runs as a public website on Vercel. Anyone aged 13 or over can sign up with a username and password, connect their YouTube channel (and Bluesky accounts), and get their own counter page at `/u/<username>`. Pages are private until their owner makes them public.

How it differs from the copy on your PC:

- **Official numbers only.** YouTube counters show the channel's official statistics from the YouTube Data API, checked about once a minute. There's no estimated "live" count, pace, chart or goal bar for YouTube, because YouTube's API rules don't allow showing independently calculated figures to the public.
- **YouTube and Bluesky only.** TikTok, Twitch and Kick aren't offered on the website, because they have no official API for this and their terms don't allow reading their pages automatically. Instagram isn't offered either, because its API only works with each person's own access token.
- **No uploads.** People can't upload pictures or sounds, so there's nothing for you to check or moderate there.
- **Privacy built in.** Privacy policy, terms and cookie policy pages, a privacy choices banner (fonts from Google and Vercel Web Analytics only run if a visitor allows them), and nothing personal stored about visitors.

## The pages

| Address | What it is |
| --- | --- |
| `/` | Home page: what the site does, how it works, questions and answers |
| `/signup` | Create an account. Shows a recovery code once, for getting back in without an email address |
| `/signin` | Sign in |
| `/forgot` | Set a new password with the recovery code |
| `/account` | Make the page public or private, change password, new recovery code, sign out everywhere, download your data, delete the account |
| `/u/<username>` | Someone's counter page. The owner can change it while signed in. Everyone else only sees it if it's public |
| `/contact` | How to report a page, complain, ask about data, or report a security problem |
| `/privacy`, `/terms`, `/cookies` | The legal pages |
| `/admin` | For you only (the **Site owner** link at the bottom of every page): add the site's YouTube API key, and look up, suspend or delete an account |

## What's in this folder

| Path | What it is |
| --- | --- |
| `public/` | The pages, styles and scripts visitors download |
| `api/index.js` | The server part: one Vercel Function that answers every `/api/...` request |
| `src/` | Shared code for reading YouTube and Bluesky, and talking to the database |
| `vercel.json` | Vercel settings: where the pages are, the page addresses, the London region, and security headers |
| `package.json` | Tells Vercel this is a Node.js project. There's nothing to install. |

## Put it online

You need a free [Vercel](https://vercel.com) account. Vercel's free **Hobby** plan is for personal, non-commercial use only. If the site is for a business or makes money, use the **Pro** plan.

### 1. Upload the files

Pick one:

- **With GitHub (no command line):** create a new private repository on GitHub, choose **Add file → Upload files**, and drag in everything from this folder (keep the folders, and leave out the `data` folder, which belongs to the copy on your PC). Then in Vercel: **Add New… → Project**, import that repository, leave **Framework Preset** on **Other**, and click **Deploy**.
- **With the Vercel command line:** open a terminal in this folder and run `npx vercel`, answer the questions (accept the defaults), then run `npx vercel --prod`.

The first deployment works, but the site can't save anything until the next two steps are done.

### 2. Connect a database

In your Vercel project, open **Storage**, choose **Upstash** (Redis) from the marketplace, create a free database in a region in Europe, and connect it to this project. Vercel adds the database's address and password to the project for you. The site looks for `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, with or without a prefix.

### 3. Add your settings

In the project, open **Settings → Environment Variables** and add:

| Name | Needed? | What to put |
| --- | --- | --- |
| `ADMIN_PASSWORD` | Yes | The password for the Site owner page (`/admin`), where you can add a shared YouTube API key and deal with reports. At least 12 characters; a long random one is best. Don't reuse a password from anywhere else. |
| `OWNER_NAME` | Strongly recommended | Your name or your business's name. The legal pages show it as the person running the site. UK data protection law expects that to be stated. |
| `MAX_USERS` | Optional | The most accounts the site allows. Default `300`. When it's full, the sign-up page says so. |
| `SIGNUPS` | Optional | Set to `closed` to pause new sign-ups. Existing accounts keep working. |
| `WEB_ANALYTICS` | Optional | Set to `1` to offer visitors Vercel Web Analytics (see step 6). |
| `SESSION_SECRET` | Optional | Any random text of 32 characters or more. It signs the sign-in cookies. Without it, the site makes one and keeps it in the database. Changing it signs everyone out. |
| `YOUTUBE_API_KEY` | Not needed | Everyone pastes their own key, and a shared key goes on the Site owner page (step 4). A key set here is only used as the shared key when none is saved there. |

Then redeploy so the settings take effect: **Deployments → ⋯ next to the latest one → Redeploy**.

### 4. YouTube API keys

**Nothing to set up here.** Everyone who makes a page pastes their own free YouTube API key when they connect their channel. The setup screen shows the steps (a Google Cloud project, YouTube Data API v3 switched on, then an API key), and it takes about 3 minutes with no card. Each person's key is checked with Google before it's saved, kept with their account in the database, never shown on any page (only its last 4 characters, to its owner), and deleted when they disconnect YouTube or delete their account. Their channel is read with their own key, so every page has its own free daily allowance of 10,000 units, and a channel read once a minute uses at most 1,440.

**Optional: a shared key**, so people can skip that step. Open your site, click **Site owner** at the bottom of any page (or go to `/admin`), sign in with your `ADMIN_PASSWORD`, and paste a key under **Set up the site → Shared YouTube key**. It's checked with Google first, and the page tells you exactly what's wrong if Google refuses it. Channels added without a key of their own are then read with it: the site reads them all together once a minute, 50 channels per request, at 1 unit each, so the shared key covers about 300 channels watched around the clock. If Google ever stops accepting it, the Site owner page says why. Use a separate key for the website, not the one the counter on your PC uses, because the PC app uses most of its key's daily allowance by design.

### 5. Make your own account

1. Open your site, click **Sign up**, and pick your username (for example the name you use on YouTube). Usernames are first come, first served, so do this before you share the link.
2. Save the recovery code it shows you. It's the only way back in if you forget your password, because the site doesn't ask for an email address.
3. Enter your channel, paste your own YouTube API key (the steps are on that screen; skip it if you added a shared key in step 4) and click **Start counting**. Press `S` (or the gear icon) to add Bluesky counters and change the look.
4. On **Account**, make your page public when you're ready for others to see it.

### 6. Optional: visit counting

In Vercel open **Analytics** and enable **Web Analytics**, then add the `WEB_ANALYTICS` setting with the value `1` and redeploy. Visitors are then asked first, and it only runs for those who say yes.

### 7. Optional: your own domain

In Vercel: **Settings → Domains**. HTTPS is set up automatically.

## Dealing with reports

Every public page has a **Report this page** link, which opens an email to the business address on the contact page. To act on a report:

1. Go to `/admin` and sign in with your `ADMIN_PASSWORD`.
2. Look up the username (you can paste the page's address).
3. **Suspend** hides the page from everyone and stops the owner changing it, but they can still sign in, download their data and delete the account. Add a short reason; the owner sees it. **Lift suspension** undoes it. **Delete account** removes it for good.

The contact page promises a reply within 7 days, and to complaints and appeals within 14 days. Keep to that, or change the contact page.

## For OBS

Each person's overlay address is their page address followed by `?overlay` (for example `https://your-site.vercel.app/u/yourname?overlay`), and **Settings → Stream** builds it. The page has to be public for OBS to show it, because OBS isn't signed in.

## Free plan limits

- **Upstash:** the free database allows 500,000 commands a month. A page that's open uses about 1 to 2 commands a minute, plus about 4 a minute shared by everyone for reading the platforms. That's roughly enough for 4 or 5 pages kept open around the clock, or many more that are only open while their owners are streaming. Public pages are cached on Vercel's network for a minute, so lots of visitors to one page cost about the same as one. Check usage in the Upstash dashboard. If it gets close to the limit, set `SIGNUPS` to `closed`, lower `MAX_USERS`, or move to a paid Upstash plan.
- **Vercel Hobby:** comfortably enough for this at small scale, and only for non-commercial use.
- **Unused accounts:** an account whose page isn't opened for 12 months is deleted automatically, as the privacy policy says.

## Before you share the link

- Set `OWNER_NAME`, so the legal pages say who runs the site.
- Try connecting a channel with your own API key (step 5), so you know the setup screen works for others.
- Sign up for your own username first.
- **ICO data protection fee:** the site keeps accounts (usernames and password hashes), so check whether you need to pay the fee using the ICO's short self-assessment on its website. Some non-commercial sites are exempt, but check.
- **Online Safety Act:** people can make pages that others see, so the site may count as a user-to-user service. Ofcom has an online tool to check whether the rules apply. If they do, you need to write down an illegal content risk assessment and a children's access assessment (Ofcom publishes guidance and templates), and keep the reporting and complaints routes on the contact page working. The site already has those routes, no uploads, no messaging, pages that are private by default, and a way for you to suspend or remove pages.
- If the site is for a business: use Vercel Pro, and the UK's E-Commerce Regulations also require your business name, a geographic (postal) address and your email on the site, plus your company and VAT numbers if you have them. Add those to the footer and legal pages.
- Keep the promises in the privacy policy: reply to privacy requests within one month, and delete old emails as it says.
- If you change what the site collects or which services it uses, update the policies and their dates. If you change the terms in a way that matters, change `TERMS_VERSION` in `api/index.js` and the version on the terms page.

This guide and the legal pages are a careful starting point, not legal advice. If the site becomes a business or grows large, it's worth having a solicitor look over them.
