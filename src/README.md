# Tacmap

A tactical map for play-by-week wargames. You own the map. Players get an invite link, draft their moves for the turn, and see nothing of each other's drafts. Once a week you lock the turn, review every draft on the map, and push. Viewers get read-only links.

This folder is the whole site, already built. There is nothing to compile and no command line.

| File | What it is |
| --- | --- |
| `index.html` | The owner's editor (you sign in with email and password) |
| `play.html` | The player page (opened through an invite link) |
| `view.html` | The read-only viewer (opened through a share link) |
| `config.js` | Two settings you edit once: your Supabase URL and public key |
| `setup.sql` | The whole database. Paste it into Supabase once, and again after an upgrade |
| `assets/` | The app's code. Do not edit |
| `.nojekyll` | Tells GitHub Pages to serve the folder as is |
| `.github/workflows/keepalive.yml` | Optional: keeps the free Supabase project awake |

## Setup checklist

About 15 minutes, all clicks. You need a GitHub account and a Supabase account, both free.

**GitHub**

1. Create a repository: github.com > **New repository**. Name it anything. Set it to **Public** and tick **Add a README file** so the `main` branch exists. On a free GitHub account Pages only works for public repositories. That is safe here: the repository holds no data and no secrets. The key in `config.js` is the public key that every visitor's browser needs anyway, and the database decides what each visitor may do (row level security).
2. Upload the site: in the repository, **Add file > Upload files**. Open this `release` folder on your computer, select everything inside it (not the folder itself) and drag it in. Click **Commit changes**.
3. Check the hidden files. Drag-and-drop often skips names that start with a dot. Look at the repository's file list:
   - If `.nojekyll` is missing: **Add file > Create new file**, type `.nojekyll` as the name, type a single space as the content, **Commit changes**.
   - If you want the keep-alive (recommended, see below) and `.github` is missing: **Add file > Create new file**, type `.github/workflows/keepalive.yml` as the name (typing the slashes creates the folders), paste the content of that file from this folder, **Commit changes**.
4. Turn on Pages: **Settings > Pages > Build and deployment**. Source: **Deploy from a branch**. Branch: **main**, folder **/ (root)**. Save. After a minute the page shows your address, `https://<you>.github.io/<repo>/`.

**Supabase**

5. Create a project: supabase.com > **New project**. Pick any name and region, let it generate a database password (you will not need it), and wait for it to finish.
6. Create the database: **SQL Editor > New query**. Open `setup.sql`, copy all of it, paste, click **Run**. It ends with "Success".
7. Allow players to join: **Authentication > Sign In / Providers**. Turn on **Allow anonymous sign-ins**. Leave **Allow new users to sign up** on.
8. Tell Supabase where the site lives: **Authentication > URL Configuration**. Set **Site URL** to your address from step 4, including the final slash. This is where confirmation and password-reset emails send you back to.
9. Copy two values from **Project Settings > API**: the **Project URL** and the **anon** (also called publishable) key. Never the `service_role` or secret key.

**Connect the two**

10. Edit `config.js`: in the GitHub repository click `config.js`, then the pencil. Replace the two placeholder values with what you copied in step 9. **Commit changes**. Wait a minute for Pages to republish.
11. Claim ownership: open your site address. The first-run page checks the connection, the database version and the anonymous sign-in setting, and tells you what to fix if something is off. Create an account with your email and a password, confirm the email if Supabase asks, sign in, and click **Claim ownership of this installation**. Do this before you give the address to anyone: the first account to claim is the owner, and after that the claim screen is gone.

That is the last time you need Supabase or GitHub to run a game.

**Optional: keep-alive.** Supabase pauses free projects after about a week with no database activity. If `.github/workflows/keepalive.yml` is in the repository, GitHub pings the database every three days. Start it once by hand: repository > **Actions** > **Keep alive** > **Run workflow**. Each run also commits a one-line timestamp file, because GitHub switches scheduled workflows off in repositories with no activity for 60 days. The last ping shows in the app under Manage > Diagnostics.

## Running a game

1. **Build the map.** Place units and graphics, draw control measures. Upload your own graphics with the Graphics tool (G).
2. **Players** (top bar): create an invite per player with a name, team and colour. Send each player their link. Optionally set a 4-digit PIN and tell them the PIN some other way.
3. **Assign units.** Select units on the map (shift-click or box-select for several) and pick the player under "Assigned to".
4. **Turn** (top bar): open turn 1. Set the deadline, the move radius, the conflict distance, and any reinforcements. To limit where reinforcements may be placed, draw a polygon or circle, select it, and click "Use selected shape".
5. During the week players drag their units inside the range circle, place reinforcements, set headings and orders, and mark their draft ready. It all saves by itself. After the deadline their drafts freeze.
6. **Lock for review.** Every draft appears on your map as ghosts in the player's colour. Drafts not marked ready are flagged "not ready"; you decide whether to accept them. Untick a change to reject it, "Edit on map" to adjust a draft, add a note per player. Conflicts (units of different players ending closer than your conflict distance) are listed and ringed in red.
7. **Push turn.** The accepted changes land on the live map in one step, the turn is stored in the history, and the next turn opens with the same settings. Only now do players and viewers see anything.

### Tech tree, points and purchases

Players can buy their own reinforcements instead of you allocating them.

- **Tech** (top bar) > **Tech tree** is a flowchart. "New item" or "New building" adds a box; drag boxes anywhere. Click a box and use its arrow buttons (→+ ↓+ ←+ ↑+) to add a new item in that direction that requires it. Drag one of a box's blue dots onto another box to make that one require it; select a box and click ✕ on an arrow to remove the link. − / + / Fit zoom, drag the background to pan.
- Each item has a research cost (0 = available from the start), prerequisites, and, if players can buy it, a unit (NATO symbol or graphic) and a spawn cost. An item can also pay **income** (spawn and/or research points per turn for every unit of it on the map) and be a **spawn point** (bought units may be placed within its radius).
- **Production buildings** ("New building", or the Kind switch on any item): players build them with spawn points at the cost you set, they cannot be moved once placed (untick "Players can move it once placed" to allow it), and units are placed within their radius. For a unit, "Produced at" limits it to certain buildings (a tank only at a Factory); tick nothing to allow any spawn point. A box grown from a building is a unit made there.
- **Where bought units and buildings may go**, per item: near one of the player's own spawn points, inside a spawn zone, either, or anywhere.
- **Tech > Spawn zones**: add a whole **country** (type its name), or click "Draw a zone on the map", draw a polygon or circle, and the window comes back to add it. Each zone is for one player, a team or everyone; rename or reassign it in the list. Zones show on your map as dotted outlines.
- **Tech > Player points**: set each player's spawn and research points, hand out points to everyone or a team, and grant or remove research by hand.
- To make a unit you placed yourself earn income or act as a spawn point, select it and pick its **Tech type** in the properties panel (it must also be assigned to a player).
- Players research and buy inside their weekly draft. Nothing is charged until you push; a rejected purchase or research costs nothing. A unit can be bought in the same draft that researches it; a new research still needs its prerequisites researched in an earlier turn. Rejecting a research in review also rejects what the draft buys from it. Income is paid at each push, for the units each player owns after the turn's moves.
- Balances are stored with every turn, so a rollback restores them. Manual reinforcements (Turn > Reinforcements) still work alongside the tree.

Everyone has a turn slider to step back through earlier turns. Under Manage > History and backup you can view any turn, roll back to one, and download or restore a backup.

## Updating to a newer version

1. Upload the new `release` folder the same way as in step 2, but leave `config.js` out of the upload (or re-enter your two values afterwards).
2. Open the site. If it says "The database needs an upgrade", paste the new `setup.sql` into the Supabase SQL editor and run it. Running it again is always safe: it keeps your data and rebuilds only functions and rules.

## If something stops working

**"Cannot reach Supabase."** The project is probably paused. Open supabase.com, pick the project, click **Restore project**. It is back in a few minutes with all data. Supabase keeps a paused free project restorable for about 90 days, so download a backup (Manage > History and backup) before any long break. Then check that the keep-alive is running: repository > Actions.

**Keep-alive runs are failing.** GitHub emails you when that happens. The cause is nearly always a paused project (above) or placeholder values still in `config.js`.

**A player lost access.** Their invite link works on any device and moves the seat there. If you revoked them or issued a new link, send the new link from Players.

**You forgot your password.** On the sign-in page, type your email and click "Forgot password". The link in the email brings you back to choose a new one.

**Owner recovery.** Only if the owner account itself is gone for good (email address lost) and there is no co-admin who could take over. Run this one statement in the Supabase SQL editor, then open the site, sign in with a new account and claim ownership again. Maps, players and history are untouched.

```sql
delete from private.admins;
```

## Where every setting lives

Nothing in this table needs Supabase or GitHub. Each control calls a database function that checks you are an admin and validates the input again on the server.

| Setting | Where in the app | Database function |
| --- | --- | --- |
| **Maps** | | |
| Create a map | Manage > Maps > New map | `create_map` |
| Rename, archive, restore | Manage > Maps (name is also editable in the top bar) | `update_map` |
| Default basemap | Top bar: Satellite / Topo | `update_map` |
| Starting view | Top bar: Set start view | `update_map` |
| Which graphics and symbols players may be given | Manage > Maps > palette | `update_map` |
| Upload graphics | Graphics tool (G) > Upload | `add_asset` (file goes to admin-only storage) |
| Remove and restore graphics (soft delete) | Graphics tool (G): ✕ on a tile, "Removed graphics" | `update_asset` |
| **Players** | | |
| Create an invite (name, team, colour, layers) | Players > New invite | `create_player` |
| Edit name, team, colour, target layer | Players > Edit | `update_player` |
| Copy the link | Players > Copy invite | (reads the player row) |
| Regenerate the link | Players > New link | `reset_player_invite` |
| Set, change or remove a PIN | Players > PIN | `set_player_pin` |
| Clear a PIN lockout | Players > Unlock PIN (shown while locked) | `clear_pin_lockout` |
| Revoke and restore | Players > Revoke / Restore | `update_player` |
| Last seen | Players list, and on each draft in Turn | (reads the player row) |
| Assign or unassign units, one or many | Select on map > properties > Assigned to | `assign_units` |
| Layers one player sees | Players > Edit > layer ticks | `update_player` |
| Layers a whole team sees | Players > Layer visibility for a whole team | `set_team_visibility` |
| **Turns** | | |
| Open a turn | Turn > Open turn | `open_turn` |
| Deadline, extend deadline, move radius, conflict distance, carry-over | Turn > Turn settings | `update_turn` |
| Move override per unit or per graphic type | Turn > Move overrides | `set_move_rule` |
| Reinforcements per player or team, with a zone drawn on the map | Turn > Reinforcements | `save_allocation`, `delete_allocation` |
| Lock, unlock | Turn > Lock for review / Unlock | `lock_turn`, `unlock_turn` |
| Accept or reject single changes, edit a draft, clear it, mark it ready for a player, note per player | Turn > Drafts > a player | `review_draft` |
| Push | Turn > Push turn | `push_turn` |
| **Tech tree and points** | | |
| Add, edit, delete tech items and buildings (costs, prerequisites, unit, income, spawn radius, placement, producing buildings, movable) | Tech > Tech tree | `save_tech_item`, `delete_tech_item`, `get_economy` |
| Arrange the flowchart | Tech > Tech tree: drag boxes | `move_tech_items` |
| Spawn and research points per player, hand out points | Tech > Player points | `set_player_points` |
| Grant or remove research for a player | Tech > Player points > Researched | `set_player_tech` |
| Spawn zones (countries or drawn shapes) per player, team or everyone | Tech > Spawn zones | `save_spawn_zone`, `delete_spawn_zone` |
| Tech type of a unit already on the map | Select on map > properties > Tech type | map edit (row level security) |
| **History** | | |
| View any past turn, unfiltered | Turn slider (bottom right), or Manage > History > View | `get_snapshot` |
| Roll back | Manage > History and backup > Roll back to here | `rollback_to` |
| Download a backup | Manage > History and backup > Download backup | `export_campaign` |
| Restore from a backup | Manage > History and backup > Restore from a backup file | `import_campaign` |
| **Sharing** | | |
| Create a view link (layers, expiry, live or snapshot) | Share | `create_share_link` |
| Revoke and restore a link | Share > Links | `update_share_link` |
| See which links are active | Share > Links | (reads link rows) |
| Delete a link | Share > Links > bin | row delete, admins only by row level security |
| **Settings** | | |
| Discord webhook: set, test, clear (shown masked) | Manage > Settings | `set_discord_webhook`, `test_discord_webhook`, `get_settings` |
| Add a co-admin by email, cancel an invite | Manage > Settings > Admins | `invite_admin`, `cancel_admin_invite` |
| Remove a co-admin | Manage > Settings > Admins | `remove_admin` |
| Transfer ownership | Manage > Settings > Admins > Make owner | `transfer_ownership` |
| **Diagnostics** | | |
| Schema version, connection, anonymous sign-ins, last keep-alive ping, Discord sending | Manage > Diagnostics | `diagnostics`, `app_status` |
| Activity log (who saved, readied, pushed, rolled back) | Manage > Diagnostics | `list_activity` |

Co-admin invites do not send an email. You enter the address; the person then creates an account on the site with exactly that address and is admitted on first sign-in. There is always exactly one owner: the owner cannot be removed, only replaced by a transfer.

### What still needs the Supabase dashboard, SQL or GitHub

| When | What | Why it cannot be in the app |
| --- | --- | --- |
| Once | The setup checklist above | The site and the database have to exist before the app can run |
| Per upgrade | Upload the new release; re-run `setup.sql` if the app asks | A web page cannot replace its own files, and the public key must never be able to change the schema |
| Recovery | Owner recovery (one SQL statement) | Deliberately impossible from the app: anyone who could do it there could take over the game |
| Recovery | Restoring a paused Supabase project | The database is switched off, so there is nothing for the app to talk to. The keep-alive exists to stop this happening |
| Only if you want it | Moving to a custom domain | DNS and Pages settings, then update the Site URL (step 8). Players re-open their links once |

## Rules the database enforces

Client checks exist only to make the pages pleasant. These hold no matter what a browser sends:

- A player can change only the position, heading and order of units assigned to them, and place units from their own or their team's reinforcements.
- Movement is measured from where the unit stands on the live map, not from the last drag. Drafts never touch the live map, so that is the start-of-turn position.
- Reinforcements must be inside the zone and within the quantity. A team pool is first come, first served; a placement you reject in review goes back into the pool.
- After the deadline a draft cannot be saved. After the lock nothing can change, including the ready flag.
- The push re-checks every accepted draft against the map as it is at that moment. If one change fails, nothing is applied and the message names the player and the reason.
- Drafts you edit yourself are not held to radius or zone.
- Research needs its prerequisites researched in an earlier turn; a purchase needs its item researched (or free), enough spawn points for the whole draft, and a legal spot (near the player's own spawn-point unit as it stands on the live map, or in one of their spawn zones, as the item says). The push checks all of it again. A player cannot turn a free drawing into an income source: only purchases and your own edits set a unit's tech type.
- Snapshots cannot be changed or deleted, not even by an admin.
- Old turns are filtered by the same layer rules as the live map, on the server. A viewer or player never receives a layer their link does not include, in any turn.
- A rollback restores the map and opens a new turn labelled "rolled back from turn N". Later turns stay in the history and the drafts of the abandoned turn are kept.
- Graphics are never hard-deleted, because old turns refer to them.

Sanity limits, the only ones there are: 200 changes and 256 kB per draft, 200 players per map, PIN lockout for 15 minutes after 5 wrong tries.

## Security notes

- **Viewers** can call one function, `get_shared_map`, and it answers only for a valid, unexpired, unrevoked token.
- **Players** are anonymous Supabase sessions bound to an invite. They have no access to any table. Everything goes through four functions that check the session against the invite.
- **The invite link is the credential.** Opening it on another device moves the seat there and signs the old browser out. Without a PIN, whoever has the link has the seat. With a PIN the link alone is not enough. PINs are stored salted and hashed.
- **Admins** are listed in a private table. Being signed in is never enough: a stranger who creates an account can do nothing.
- **Tokens** live in the part of the address after `#`, which browsers do not send to GitHub or to map tile servers.
- **The Discord webhook** can be written and tested but never read back; only Discord addresses are accepted.
- **A backup file contains invite and share links.** Keep it as private as a password.
- **Framing.** GitHub Pages cannot send security headers, so the content security policy is a tag inside each page. That cannot forbid other sites from embedding yours in a frame. If that matters, put Cloudflare in front of a custom domain.
- **Uploads** are checked by content, limited to PNG, WebP and SVG up to 2 MB, and SVGs are sanitised before upload and before every render.

## Discord

Manage > Settings: paste a webhook URL (Discord: channel settings > Integrations > Webhooks). "Send test message" checks it. On every push the database posts "Turn N is live". This uses Supabase's `pg_net` extension, which `setup.sql` switches on. Sending is queued, so a slow or broken webhook never delays a push.

## Basemaps and licences

Both basemaps are free and need no key. Fine for a private game; check the terms before anything commercial or high-traffic.

| Basemap | Source | Notes |
| --- | --- | --- |
| Satellite | Esri World Imagery | Attribution required. Esri expects an ArcGIS account for production apps |
| Topo | OpenTopoMap | CC-BY-SA, volunteer-run, max zoom 17, no bulk downloading |

Country borders for spawn zones: Natural Earth 1:50m (public domain) via the world-atlas package (ISC), in `countries.json`. Borders are simplified and follow Natural Earth's de facto boundaries; disputed areas may not match what your players expect.

Libraries: MapLibre GL JS (BSD-3), milsymbol (MIT), Turf (MIT), DOMPurify (Apache-2.0/MPL-2.0), supabase-js (MIT), zustand (MIT), React (MIT).

Free-tier limits that matter: Supabase 500 MB database and 1 GB file storage; GitHub Pages 1 GB site and about 100 GB of traffic a month. Supabase's built-in email sends only a few messages an hour, which is enough for the odd confirmation or password reset.

## Changing the code

The source is in the `src` folder of this repository. GitHub Pages serves the built files in the repository root; `src` is not needed to run the site.

```bash
cd src
npm install
npm test             # database rules against a real Postgres (PGlite) + unit tests
npm run fake         # the built site on http://localhost:54399 with a throwaway local database
npm run dev          # dev server; put VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY in .env.local
npm run release      # typecheck, build into src/dist, then copy the site into the repository root (keeps config.js)
```

`npm run fake` runs the real `setup.sql` in an in-process Postgres behind a small stand-in for Supabase's API, so the whole app can be tried with no account. `tests/e2e/scenario.mjs` drives a complete turn through it in a headless browser, and `tests/e2e/tech.mjs` the tech tree (both need Playwright installed separately).

When you change the database, edit `supabase/setup.sql`, raise the number in its last statement and `SCHEMA_VERSION` in `app/lib/supabase.ts` together, and keep the file re-runnable: `tests/upgrade.test.ts` runs it over an older schema and twice in a row.
