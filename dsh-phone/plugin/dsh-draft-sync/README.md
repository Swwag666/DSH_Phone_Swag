# dsh-draft-sync

DSH Desktop web GUI draft sync plugin. Mirrors the unsent composer draft to
the [dsh-phone](../..) node on `127.0.0.1:8460` and back, so a draft written
on the phone (PWA) shows up in the desktop composer and vice versa.

This is the no-asar-patching answer: the plugin rides the official DSH plugin
system (`dsh profile bundles` + `dsh.client` browser half), so DSH Desktop
itself is never modified. Removing the plugin = deleting one line from the
profile manifest; a broken plugin degrades to a FAILED fiber warning instead
of a dead GUI.

## Shape

- `package.json` - `dsh.bundle.patch` (host layer) + `dsh.client`
  (`platform: "web"`, no inject: the engine needs zero client services).
- `cordis.patch.yml` - inserts the `dsh-draft-sync` entry into the web plugin
  roster (node half is a no-op `apply`).
- `lib/index.js` - node half: empty `apply`, exists only so the Loader entry
  exists and `dsh-client-modules` scans the `dsh.client` declaration.
- `lib/client.js` - browser half: `window.__ModuleLoader__.load` lazy-CJS
  factory exporting a cordis plugin (`apply` + empty `inject`). The engine:
  fetch-`/api/draft-config` bootstrap, `/api` POST sniffing for the active
  `session-<uuid>`, composer `[data-composer-input]` watch with 600ms debounce
  push, `/api/events` long-poll pull, `execCommand("insertText")` remote apply
  (through the Lexical input pipeline), 2.5s busy-typing grace, origin-based
  echo suppression, loadExistingDraft on session open.

## Install (manual, no pnpm)

Copy this folder to
`%USERPROFILE%\.dsh\profiles\desktop\node_modules\dsh-draft-sync\` and add
`"dsh-draft-sync"` to `dsh.profile.bundles` in
`%USERPROFILE%\.dsh\profiles\desktop\package.json`, then restart DSH Desktop.

Caveat: the entry is not in the profile lockfile, so a later
`dsh plugin --profile desktop add ...` (or any pnpm install in the profile)
may prune the directory - re-copy it from this repo if that happens.

## Debug

`[dsh-draft-sync]` lines in the desktop web console. The plugin loads from
`/plugins/dsh-draft-sync/client.js?rev=...`; its graph row is visible in
`window.__DSH_BOOT__.entries`.
