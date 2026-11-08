# Vendored upstream source

Source: https://github.com/SAOS-3624/dsh-video-storyboard
Commit: 65b81c5b441bbd4b2f3952a14de42a94a31bc983
License: MIT; original copyright and LICENSE/NOTICE are retained.

Only scene scanning, segment selection, pure layout and composition helpers are used.
Upstream downloader, ASR, global cache/history and DSH plugin registration are not installed.
Local scan.js changes add bounded sampling, single-thread/resource arguments, capped stderr and wait-for-close cancellation.
All media files and frame extraction remain owned and guarded by the QQ bridge.
