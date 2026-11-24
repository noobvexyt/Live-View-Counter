# Live View Counter

Your YouTube channel's total views, counting up live: a big rolling number with your channel name and logo.

## Start it

Double-click the **Live View Counter** icon on your desktop (or **`Start Live View Counter.bat`** in this folder). Your browser opens at http://localhost:4747.

The counter runs **hidden in the background**: no window to keep open. Close the browser tab whenever you like; the counter keeps tracking, and the icon just reopens the page.

- **Starts with Windows**: it starts by itself (hidden) when you sign in. Turn that on or off in **Settings → Running in the background**.
- **Stop it**: **Settings → Stop the counter**, or double-click **`Stop Live View Counter.bat`**.
- **Set up the desktop icon and start-with-Windows again** (for example after moving this folder): run `node server.js --install` here. `node server.js --uninstall` removes both and stops the counter.
- **Run it in a visible window instead** (for troubleshooting): `node server.js --open`. Closing that window stops it.
- While it runs in the background, its messages go to `data/server.log`.

You only set up the key once. After that, nothing needs Google Cloud open: the counter talks to YouTube on its own using the saved key.

The first time, the page asks for two things:

1. **Your channel**: your `@handle`, your channel link, or a link to any of your videos.
2. **A YouTube Data API key**: it's free and takes about 3 minutes. The setup page walks you through it:
   - [Create a Google Cloud project](https://console.cloud.google.com/projectcreate)
   - [Enable YouTube Data API v3](https://console.cloud.google.com/apis/library/youtube.googleapis.com) for that project
   - [Credentials](https://console.cloud.google.com/apis/credentials) → **Create credentials** → **API key**
   - Recommended: restrict the key to *YouTube Data API v3*. Leave *Application restrictions* on *None*.

The key is saved only on this computer, in `data/config.json`. Don't share that folder.

## How the live count works

- YouTube only refreshes the total on your channel page every so often. So this app tracks **every public video's view count**, which YouTube keeps much fresher, and adds them up.
- It re-reads the 50 videos most likely to have new views as often as the free quota allows (about every 5 seconds, never faster than every 2). Busy and new videos get checked constantly, and old quiet ones every so often. New uploads are picked up within about 4 minutes.
- YouTube itself refreshes each video's count in bursts (a busy video can jump by a minute's worth of views at once). So between readings the number keeps rolling at your channel's real pace, measured from the last 30 minutes of readings, and each new reading keeps it in line. It never runs more than about a minute's worth of views ahead of what YouTube has reported.
- The number never goes backwards while it's running. Views on videos you delete or hide are kept for 30 days, then dropped, because YouTube's API rules allow storing its data for at most 30 days without refreshing it. If YouTube's own total is ever higher (for example, it includes views on deleted videos), the counter lifts itself to match.
- The rolling number between readings is an estimate made by this app. YouTube's API rules don't allow showing independently calculated figures like this publicly, so for anything public (a website, or a stream overlay) the safer choice is the website version, which shows only YouTube's own numbers. See `VERCEL.md`.
- It paces itself to YouTube's free daily allowance, which resets at midnight Pacific time. Leaving it running 24/7 is fine. It uses both of YouTube's free quota pools (the standard one and the newer `videos:batchGetStats` one) when available.
- Progress is saved in `data/state.json`, so restarting picks up where it left off.

## Other platforms

Add more counters in **Settings → Counters → Add a counter**. Up to 16 counters fit, each with its own logo, colours and pace.

| Platform | Numbers | What it needs | Checked every |
| --- | --- | --- | --- |
| YouTube | total views, subscribers, videos | your API key (above) | ~5 s |
| TikTok | followers, likes, videos | just the `@name` | 45 s |
| Twitch | followers, live viewers | just the channel name | 20 s |
| Kick | followers, live viewers | just the channel name | 30 s |
| Bluesky | followers, posts | just the handle (`name.bsky.social`) | 30 s |
| Instagram | followers, posts | an Instagram access token (see below) | 60 s |

- TikTok, Twitch and Kick don't offer free official APIs for this, so the counter reads the same public numbers their own websites show. If one of them changes its website, that counter may stop updating until it's fixed. It says so on the card and keeps retrying (backing off to every 10 minutes).
- **Instagram** only gives follower counts through its official API, to your own Business or Creator account. The Add form has a step-by-step guide to getting a token from developers.facebook.com. The token stays on this computer (`data/config.json`) and is renewed automatically every week.
- **X (Twitter), Facebook, Threads and Snapchat** aren't supported.
- Between checks, followers, likes and views count smoothly at the measured pace, so the number keeps moving.
- Open a counter in the list to give it your own label, set a goal, hide it, or move it up and down.

## Settings

Press `S` or use the gear icon. Changes save on the server, so every browser and OBS source picks them up within a second.

- **Counters**: add, remove, reorder, label, and set goals. Show one at a time (switch with the arrows or `←`/`→`), all at once in a grid, or take turns every few seconds.
- **Text**: 19 fonts, weight, size, letter spacing, thousands separator (`1,234` / `1 234` / `1.234` / `1'234` / none), number colour (white, logo colours, one colour, or a two-colour gradient), glow, dark outline, and the name and label sizes.
- **Look**: animation style (**3D** rolling drums, **Classic** sliding digits, or **Plain**), roll speed, background (aurora, colour, gradient, your own picture with dim and blur, or transparent), accent colour, logo shape and size, and which extras show on screen (pace and 24-hour change, a 24-hour chart, the goal bar, the "Updating live" badge). Overall size, auto-hiding buttons, and keeping the screen on.
- **Effects**: glow pulse, floating `+1`s, sparks, confetti, and the milestone banner. Milestones can be all, big ones only, or off. The **Try** buttons preview them.
- **Sound**: 8 tick sounds or your own file (up to 2 MB), plus volume, pitch, and how often it ticks. There are 4 milestone and goal chimes, each with its own volume. Browsers only allow sound after you click the page once. Press `M` or use the speaker button to turn sound on or off on that device.
- **Stream**: builds the OBS address for you (see below).
- **App**: switch YouTube channel or key, counter details and today's quota, start with Windows, stop the counter, and **Backup**: export or import all settings, or reset the look.

Keys: `F` full screen, `M` sound on or off, `S` settings, `←`/`→` previous or next counter, `Esc` closes settings.

## OBS / streaming overlay

Add a *Browser* source (1920 × 1080) with `http://localhost:4747/?overlay`. It uses the same look as the page, with a see-through background and no sound. You can add these to the address (Settings → Stream builds it for you):

- `&counter=<id>`: show just one counter.
- `&style=3d|classic|plain`: a different animation style from the page's.
- `&layout=single|grid|rotate`: a different layout from the page's.
- `&bg=show`: keep the page's background instead of see-through.
- `&sound`: play the tick sound in OBS.

## Extras

- **Full screen**: press `F` or use the button in the top-right corner. The buttons hide when the mouse is idle.
- **Phone or tablet on the same Wi-Fi**: start it with `node server.js --lan --background` and open the address it prints. Windows may ask to allow Node.js through the firewall. Settings can only be changed on the computer that runs the counter.
- Settings are saved in `data/settings.json`, and uploaded sounds and pictures are saved in `data/`.

## Requirements

[Node.js](https://nodejs.org) 18 or newer. No `npm install` needed: it uses only Node's built-in modules.
