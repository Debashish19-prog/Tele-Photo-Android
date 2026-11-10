# Tele-Photo

A Google Photos alternative that keeps your originals in your own Telegram account, at full quality.

You sign in with your Telegram phone number. Tele-Photo creates a private channel on your account called **Tele-Photo Library** and stores each photo and video there as untouched files. A timeline, albums, favorites, search and a trash all run on top of it, in a liquid glass interface.

It runs entirely in your browser. There is no server and no database, so it can be hosted for free on any static host, and any number of people can use the same site without sharing anything.

![The Tele-Photo timeline, with glass panels floating over a grid of photos](docs/screenshots/timeline.webp)

[See all the screenshots](#screenshots)

## Put it on Vercel

You need a Vercel account, this repository on GitHub, and a free Telegram API key.

1. Go to [my.telegram.org/apps](https://my.telegram.org/apps), sign in, and create an app. Any name works. Keep the **api_id** and **api_hash** it gives you.
2. In Vercel, choose **Add New → Project** and import the repository. Leave the root directory as it is, because `vercel.json` already says how to build.
3. Under **Environment Variables**, add `VITE_TELEGRAM_API_ID` and `VITE_TELEGRAM_API_HASH`.
4. Deploy. Changing these variables later needs a new deployment, as they are built into the site.

Vercel's free Hobby plan is for [non-commercial use only](https://vercel.com/docs/limits/fair-use-guidelines), so charging for this or showing ads needs a paid plan. Nothing here is specific to Vercel apart from `vercel.json`. Any host that serves static files over HTTPS works, as long as it sends the same security headers.

### Confirm it works with real Telegram

Once you have signed in, open the account menu and choose **Check Telegram storage**.

It sends a few generated images to your library channel, downloads each one, compares SHA-256 hashes, and deletes them again. It also saves and reads back the file that holds your albums. Every line should get a tick. This is the one check the automated tests cannot do for you, because they have no Telegram account to use.

**Do this before trusting it with anything.** The automated tests run the real Telegram client code with the network replaced, so they cannot do this part. The check has passed on a real account from a local production build. A live deployment, and other browsers and phones, can behave differently, so run it again on the ones you will use.

### Run it on your own computer

You need Node 22 or newer and [pnpm](https://pnpm.io).

```bash
pnpm install
cp .env.example .env     # then fill in VITE_TELEGRAM_API_ID and VITE_TELEGRAM_API_HASH
pnpm dev
```

Then open <http://localhost:5173>. It has to be `localhost` or HTTPS, because browsers only offer the cryptography it needs on secure pages. That means opening it from your phone by its network address will not work, while a deployed site will.

## The Android app

`android/` builds an APK of the same app, which can also back up the phone's gallery by itself. There is still no server: the phone talks straight to Telegram.

**It has not been tried on a phone yet.** The backup logic has automated tests, and it has run in Chrome against a simulated phone, but the Android side has only been compiled and linted. Start with the demo build, then try your real account with a few photos, and run **Check Telegram storage** from the account menu before relying on it.

### Build it

You need [Android Studio](https://developer.android.com/studio) for its SDK and Java, plus Node 22 or newer and pnpm.

```bash
pnpm install
cp .env.example .env     # then fill in VITE_TELEGRAM_API_ID and VITE_TELEGRAM_API_HASH
pnpm android:apk         # android/dist/Tele-Photo.apk
pnpm android:demo        # android/dist/Tele-Photo-demo.apk, with pretend Telegram, for testing
```

If Android Studio is not in `~/Applications/android-studio`, or the SDK is not in `~/Android/Sdk`, set `JAVA_HOME` and `ANDROID_HOME` first.

The first `android:apk` makes a signing key in `android/keystore.jks`, with its password in `android/keystore.properties`. **Keep a copy of both somewhere safe.** Neither is committed. Android only installs an update signed with the same key, so without them you would have to uninstall the app, and sign in again, to update it.

To work on it in Android Studio, open the `android` folder. Run `pnpm build` first, because the app serves whatever website is in `web/dist`.

Your API key is inside the APK and can be read out of it, as with the website, so only share an APK with people you would share the key with.

### Install it

Copy the APK to the phone and open it, allowing the install when Android asks, or run `adb install android/dist/Tele-Photo.apk` with the phone connected over USB. Google is phasing in developer verification for apps installed outside the Play Store, which can add a one-time wait to the first method in some countries. `adb` is not affected.

### How auto backup works

Turn it on from the banner in Photos, or from the account menu under **Auto backup**, and choose **Allow all** when Android asks about photos.

- **Originals only.** The app reads each file's exact bytes and sends them the same way as any other upload, so nothing is recompressed. Without the extra permission, Android would remove the location from photos before the app sees them. If that permission is missing, the app stops and asks for it, rather than back up a changed copy.
- **It only ever copies.** Removing a photo from the phone does not remove its backup. A photo you trash or delete in the app is not uploaded again. Nothing on the phone is ever changed or deleted.
- **Wi-Fi only by default.** Originals are large, so mobile data is off unless you turn it on. If Wi-Fi drops partway through a photo, that one photo may finish over mobile data.
- **In the background.** A new photo wakes the app, which shows a notification while it works and closes again afterwards. Allow **Run in the background** when asked. Without it, Android may stop the backup after about ten minutes each time, and it carries on the next time Android allows it. Some phone makers limit background apps further, and may need the app exempted from battery saving.
- **It picks up where it left off.** If anything stops it, the next run starts from the first photo not yet stored. Photos already in Telegram are recognised by their hash, so reinstalling the app reads them again but does not upload them again.
- **Files it cannot store** are counted under **Auto backup**, such as a file that only has the name of a photo.
- **Videos are not backed up yet.**
- **Force stop.** Android cancels everything for an app that is force-stopped, and some phones treat swiping an app away the same way. Backups then wait until you next open the app.

## Can other people use it?

Yes. Everyone opens the same link and signs in with their own number. Each person's library lives in their own Telegram and their own browser, so people cannot see each other's photos, and more users cost you nothing in storage or bandwidth.

Be honest with them about these:

- **They are trusting the site.** The site never receives their login or photos, and `vercel.json` stops the page sending data anywhere but Telegram. But whoever controls the deployment controls the code, and could change both. That is true of any web app, including Telegram's own. Someone who would rather not trust you can deploy their own copy.
- **The sign-in is a full Telegram login.** Inside their browser, the app holds a session with full access to their account, like Telegram Web does. It shows up under Devices in Telegram as "Tele-Photo", and they can end it there at any time. Anyone with access to that browser profile has access to the session, so it should not be used on a shared computer without signing out.
- **Telegram warns people never to share login codes**, and a site asking for one can look like phishing. A code typed here only goes to Telegram, but people cannot verify that by looking, so say so plainly.
- **Everyone shares your API key.** It is visible in the site's code, which is normal for a Telegram client. Telegram holds the key's owner responsible for how it is used, and can [withdraw access](https://core.telegram.org/api/terms) if its terms are broken. That would lock everyone out of the app at once, though their photos would stay in their own Telegram.
- **You cannot limit who signs in.** The old phone allowlist needed a server to enforce it. Strangers using your link cost you nothing and cannot see anyone's photos, but they would count against your API key.

## How your photos are stored

```
Browser ──► SHA-256, EXIF, thumbnails ──► Telegram private channel
   │                                       one photo = one message
   └── index + thumbnail cache (IndexedDB)  + one file of albums and favorites
```

Photos go directly from the browser to Telegram over an encrypted WebSocket. No server is involved at any point.

| What | Where | Lost if this browser's data is cleared? |
| --- | --- | --- |
| Original photos | Your Telegram channel | No |
| Capture date, dimensions, content hash | Telegram (in each caption) and the local index | No |
| A small thumbnail | Telegram (attached to each photo) and a local cache | No |
| Albums, favorites, Trash, camera details, which photos stay out of Photos | A file pinned in your Telegram channel, and locally | No, as long as it had time to save |
| Larger previews for the viewer | Local cache, rebuilt from the original when needed | No |

To rebuild, just sign in. The app finds your existing channel and restores the library, without downloading your originals. You can also run this any time from the account menu with **Restore from Telegram**. Libraries uploaded by the earlier server version are found the same way, though albums and favorites from its `data/` folder do not carry over.

### Photos that live only in an album

Open an album and choose **Add photos**:

- **From your library** adds photos you already have. They stay in Photos too.
- **Upload new photos** keeps them in that album only. They do not appear in Photos or in search. While an album is open, the **Upload** button and drag and drop work the same way.

These are stored like any other photo, at full quality in the same Telegram channel. The separation is in the app, so they are still visible to anyone looking through the channel in Telegram itself.

- **Favorites and Trash** still include them, as both come from something you did to that photo.
- **A file you have already stored** is not uploaded again. It joins the album, and stays in Photos if it was there. Uploading a file to Photos when it is only in an album brings it into Photos.
- **Removing one from its last album** moves it to Photos, and the app tells you when that happens.
- **Deleting an album** moves the photos uploaded only to it to Trash, and the confirmation says how many. Restoring one puts it in Photos, since its album has gone.
- **If the file holding your albums is ever lost**, these photos appear in Photos, so none can end up out of reach.

### Using more than one device

Sign in on each one. Photos and changes from other devices appear when you open the app or return to it. If two devices change the same photo or album, whichever changed it last wins, going by each device's clock.

### Why quality stays intact

- Photos are sent as **documents with `force_file` set**, never as Telegram photos, which get recompressed.
- After each upload the app checks that Telegram kept a document of exactly the same size. If not, it deletes that message and tries again.
- The original bytes are never modified. Only the thumbnails and previews are generated copies.
- Each photo's SHA-256 is recorded at upload, which also stops the same photo being stored twice.

### If something goes wrong mid-upload

The original stays on your device throughout, so nothing can be lost. Rate limits from Telegram pause the queue rather than failing it, and repeated failures stay in the uploads panel with a **Retry** button. Use **Retry all failed uploads** to restart a failed batch together.

**Uploads only run while the tab is open**, as there is no server to finish them. The page warns you before you leave, and asks a phone not to sleep while uploading. If a tab closes anyway, **Retry** asks you to select the originals again. You can select the whole batch: finished ones are skipped, and the rest pick up from there, keeping their albums.

### Videos

Videos are stored the same way as photos: as documents, with their bytes untouched and their SHA-256 recorded.

Telegram takes at most 1.95 GB per file, so a larger video goes up in pieces of 1 GiB. Each piece is its own message, named `clip.mp4.001`, `clip.mp4.002` and so on, with a caption saying which part it is and what the whole file is. This all happens in your browser, with nothing passing through the host.

- **Interrupted uploads** only lose the piece in progress. Add the same file again and it carries on from the next one.
- **Other devices** rebuild the video from the channel, and only show it once every piece has arrived.
- **Downloading** joins the pieces and checks the result against the original's SHA-256. If it does not match, the download fails rather than leaving a damaged file.
- **Watching** does not need the whole video. A small service worker (`web/public/media-sw.js`) answers the player's requests by fetching just the bytes it asks for, so a video can start and seek straight away, wherever in the pieces that falls.
- **Deleting** removes every piece.

The pieces do not play on their own in Telegram, because only the first has the start of the video. If you ever need the video without this app, download all its pieces and join them with `cat clip.mp4.* > clip.mp4`.

Whether a video plays in the app depends on your browser: H.264 MP4 and WebM play almost everywhere, HEVC depends on the device, and MKV and AVI often do not. Anything that will not play is still stored, and can still be downloaded.

## Good to know

- **Size limit:** 2,097,152,000 bytes per photo (about 1.95 GB), which is Telegram's real ceiling for non-Premium accounts: 4000 parts of 512 KB. Larger photos are refused up front. Videos have no limit, as larger ones are split.
- **Formats:** anything that is recognisably an image or a video, by its contents rather than its name. Thumbnails depend on what your browser can read: JPEG, PNG, WebP, GIF and AVIF everywhere, and HEIC through a built-in decoder. Camera RAW uses its embedded preview when it has one. TIFF only gets a thumbnail in Safari. If no preview can be made, the file is still stored and gets a placeholder tile. A video's thumbnail is a frame from it, so it depends on the browser being able to play it.
- **Privacy:** only your account can see the channel, but channels are not end-to-end encrypted, so Telegram itself could read them.
- **Your Telegram account:** this uses the official API, signing in like any third-party client. Telegram does not promise it as a storage service, and it can rate-limit or restrict accounts it considers abusive. Bulk uploads are paced to respect its limits, but keep other copies of anything irreplaceable.
- **Deleting:** Trash keeps photos for 30 days (`VITE_TRASH_RETENTION_DAYS`), then deletes them from Telegram for good. With no server to do this on schedule, it happens the next time the app is open after that, so never early. Deleting the channel from inside Telegram deletes your originals, and the app cannot get them back.
- **One tab at a time:** the app runs in a single tab, and a second one offers to take over.
- **Signing out** ends that browser's Telegram session and clears its local data. Everything else stays safe in Telegram.
- **Large videos:** a 6 GB video takes about 40 minutes to upload at 20 Mbit/s, and the tab has to stay open throughout.
- **Glass effect:** true refraction appears in Chromium browsers. Safari and Firefox automatically show frosted glass instead.

## Screenshots

These were taken in demo mode with stock sample photos from [Lorem Picsum](https://picsum.photos), which is why they carry a yellow banner. In demo mode nothing really goes to Telegram, even where a label says it did. Select any image to see it full size. Most predate the move into the browser, so a few still show older wording such as "Sending to server" or "Disconnect Telegram".

### Signing in

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/sign-in.webp"><img src="docs/screenshots/sign-in.webp" alt="Glass sign-in card over a photo of snowy mountains"></a><br>Sign in with your Telegram phone number.</td><td width="50%" valign="top"><a href="docs/screenshots/sign-in-wrong-code.webp"><img src="docs/screenshots/sign-in-wrong-code.webp" alt="Sign-in card showing a code error"></a><br>A wrong code gets a clear message, and you can try again.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/setup-needed.webp"><img src="docs/screenshots/setup-needed.webp" alt="Setup instructions on the sign-in card"></a><br>Shown until the site is built with your API key.</td><td width="50%" valign="top"><a href="docs/screenshots/empty-library.webp"><img src="docs/screenshots/empty-library.webp" alt="Empty library with an upload button"></a><br>A new library, ready for its first photos.</td></tr>
</table>

### Uploading

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/uploading.webp"><img src="docs/screenshots/uploading.webp" alt="Upload panel showing progress for several files"></a><br>Each file shows its progress, and photos appear in the grid as they arrive.</td><td width="50%" valign="top"><a href="docs/screenshots/upload-done.webp"><img src="docs/screenshots/upload-done.webp" alt="Upload panel listing finished files"></a><br>The finished batch.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/folder-drop.webp"><img src="docs/screenshots/folder-drop.webp" alt="Upload panel after a folder was dropped, with a notice about a skipped file"></a><br>Drop a whole folder. Anything that isn't a photo is skipped, and you are told.</td><td width="50%" valign="top"><a href="docs/screenshots/upload-refused.webp"><img src="docs/screenshots/upload-refused.webp" alt="Upload panel showing a refused file with its reason"></a><br>A file that only pretends to be a photo is refused, with the reason.</td></tr>
</table>

### Browsing

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/scrubber.webp"><img src="docs/screenshots/scrubber.webp" alt="Timeline scrubber showing a month label"></a><br>The strip on the right jumps through your years.</td><td width="50%" valign="top"><a href="docs/screenshots/search.webp"><img src="docs/screenshots/search.webp" alt="Search results for 2025"></a><br>Search by name, camera or date.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/selecting.webp"><img src="docs/screenshots/selecting.webp" alt="Photos selected, with an action bar along the top"></a><br>Select photos to favorite, add to an album, download or remove them.</td><td width="50%" valign="top"><a href="docs/screenshots/favorites-marked.webp"><img src="docs/screenshots/favorites-marked.webp" alt="Grid with star marks on favorite photos"></a><br>Favorites are marked with a star.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/stress-test.webp"><img src="docs/screenshots/stress-test.webp" alt="Grid of photos spanning many years"></a><br>A stress test with 50,000 simulated photos. Only the tiles near the screen are ever loaded.</td><td width="50%"></td></tr>
</table>

### Viewing a photo

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/viewer-info.webp"><img src="docs/screenshots/viewer-info.webp" alt="Full-screen photo with an info panel"></a><br>Date, camera details and where the original is stored.</td><td width="50%" valign="top"><a href="docs/screenshots/viewer.webp"><img src="docs/screenshots/viewer.webp" alt="Full-screen portrait photo with glass controls"></a><br>Full screen, with the panel closed.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/viewer-zoom.webp"><img src="docs/screenshots/viewer-zoom.webp" alt="Zoomed-in photo of a tram"></a><br>Zoom in, and the original loads from Telegram for full detail.</td><td width="50%" valign="top"><a href="docs/screenshots/viewer-trash.webp"><img src="docs/screenshots/viewer-trash.webp" alt="Viewer showing a photo in Trash with days remaining"></a><br>A photo in Trash shows how long it has left.</td></tr>
</table>

### Albums

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/add-to-album.webp"><img src="docs/screenshots/add-to-album.webp" alt="Dialog for adding photos to an album"></a><br>Add selected photos to a new or existing album.</td><td width="50%" valign="top"><a href="docs/screenshots/albums.webp"><img src="docs/screenshots/albums.webp" alt="Albums page with one album"></a><br>Your albums.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/album.webp"><img src="docs/screenshots/album.webp" alt="Album page with four photos"></a><br>Inside an album.</td><td width="50%" valign="top"><a href="docs/screenshots/album-renamed.webp"><img src="docs/screenshots/album-renamed.webp" alt="Album page after renaming"></a><br>A renamed album.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/album-menu.webp"><img src="docs/screenshots/album-menu.webp" alt="Album options menu"></a><br>Rename or delete an album. Photos from your library stay there, and any uploaded only to this album move to Trash.</td><td width="50%"></td></tr>
</table>

### Trash

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/trash-undo.webp"><img src="docs/screenshots/trash-undo.webp" alt="Notice with an Undo button after moving a photo to Trash"></a><br>Moved something by mistake? Undo is right there.</td><td width="50%" valign="top"><a href="docs/screenshots/trash.webp"><img src="docs/screenshots/trash.webp" alt="Trash page with one photo"></a><br>Photos wait in Trash before they are deleted for good.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/empty-trash.webp"><img src="docs/screenshots/empty-trash.webp" alt="Confirmation dialog for emptying the Trash"></a><br>Anything permanent asks first.</td><td width="50%"></td></tr>
</table>

### Account and dark mode

<table>
<tr><td width="50%" valign="top"><a href="docs/screenshots/account-menu.webp"><img src="docs/screenshots/account-menu.webp" alt="Account menu with appearance options"></a><br>Appearance, restore, the storage check and sign out.</td><td width="50%" valign="top"><a href="docs/screenshots/account-menu-over-photos.webp"><img src="docs/screenshots/account-menu-over-photos.webp" alt="Account menu open over photos"></a><br>The menu stays readable over any photo.</td></tr>
<tr><td width="50%" valign="top"><a href="docs/screenshots/dark.webp"><img src="docs/screenshots/dark.webp" alt="Timeline in dark mode"></a><br>Dark mode.</td><td width="50%" valign="top"><a href="docs/screenshots/dark-scrolled.webp"><img src="docs/screenshots/dark-scrolled.webp" alt="Scrolled timeline in dark mode"></a><br>Photos scroll underneath the glass.</td></tr>
</table>

### On a phone

<table>
<tr><td width="25%" valign="top"><a href="docs/screenshots/phone.webp"><img src="docs/screenshots/phone.webp" alt="Timeline on a phone with star marks on favorites"></a><br>Favorites show a star.</td><td width="25%" valign="top"><a href="docs/screenshots/phone-timeline.webp"><img src="docs/screenshots/phone-timeline.webp" alt="Timeline on a phone"></a><br>The timeline.</td><td width="25%" valign="top"><a href="docs/screenshots/phone-selecting.webp"><img src="docs/screenshots/phone-selecting.webp" alt="Selecting a photo on a phone"></a><br>Press and hold to select.</td><td width="25%" valign="top"><a href="docs/screenshots/phone-viewer.webp"><img src="docs/screenshots/phone-viewer.webp" alt="Photo viewer on a phone"></a><br>The viewer.</td></tr>
</table>

<a href="docs/screenshots/phone-tabs.webp"><img src="docs/screenshots/phone-tabs.webp" alt="The tab bar on a phone, with Photos, Favorites, Albums and Trash" width="390"></a>

## Development

```bash
pnpm dev              # the web app with hot reload, on :5173
pnpm test             # the test suite
```

To try the app without a Telegram account, set `VITE_STORAGE=fake` in `.env`. Any phone number works with code `12345` (a number ending in 2 also asks for the password `hunter2`). Photos stay in the browser, and a yellow banner says so. To try splitting without gigabytes of video, also set `VITE_FAKE_PIECE_BYTES`, which only affects this mode.

| Path | What it does |
| --- | --- |
| `web/src/engine/index.ts` | Everything the app can do, in one place |
| `web/src/engine/telegram.ts` | Everything that talks to Telegram |
| `web/src/engine/fake.ts` | The stand-in used by tests and demo mode |
| `web/src/engine/store.ts` | The local index, in memory and IndexedDB |
| `web/src/engine/queue.ts` | The upload queue |
| `web/src/engine/sync.ts` | Albums and favorites between devices |
| `web/src/engine/media.ts` | File checks, EXIF, thumbnails |
| `web/src/engine/caption.ts` | What each Telegram message's caption holds |
| `web/src/engine/pieces.ts` | Splitting large videos into pieces and joining them again |
| `web/src/engine/mediaWorker.ts` and `web/public/media-sw.js` | Playing and saving a stored video through a service worker |
| `web/src/components/` | The interface |
| `web/src/components/ui/` | [Liqui UI](https://liqui.design) components, installed as source |
| `vercel.json` | How to build the site, and the security headers it must be served with |

The stack is [GramJS](https://github.com/gram-js/gramjs), IndexedDB, React, Tailwind, Liqui UI and [Motion](https://motion.dev), all in the browser.

The photo on the sign-in screen and behind the app is [Rogers Peak in Winter](https://commons.wikimedia.org/wiki/File:Rogers_Peak_in_Winter_(de4cdfd1-f792-4696-84d1-c911d2b4f2e9).JPG) by the US National Park Service, which is in the public domain. It is colour-graded for this app.
