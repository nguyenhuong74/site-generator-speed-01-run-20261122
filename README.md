# site-generator-speed-01-run-20261122

[![make.fun · site-generator-speed-01-run-20261122](https://make.fun/badge/site-generator-speed-01-run-20261122.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![rank](https://make.fun/badge/site-generator-speed-01-run-20261122/nguyenhuong74/site-generator-speed-01-run-20261122/rank.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)
[![reward](https://make.fun/badge/site-generator-speed-01-run-20261122/nguyenhuong74/site-generator-speed-01-run-20261122/reward.svg)](https://make.fun/bounty/site-generator-speed-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=site-generator-speed-01-run-20261122)

A fast, dependency-free reimplementation of makefun-site 1.0.0 — a static site
generator that turns one site's Markdown sources, templates and static files
into its output tree, byte for byte.

`solve.js` exports `run(input)`, returning exactly the answer makefun-site
1.0.0 returns for the same input: every page's `index.html`, the index and
tag pages, `build-report.txt` and each static file. It reimplements the
reference's own dialect from scratch — its front matter, template dialect,
Markdown subset, slug rule and report — and is faster through:

- a fused Markdown lexer/renderer that classifies each line once and streams
  blocks straight into the output;
- inline rendering over index ranges, driven by one native scan for the next
  character that needs handling, with no per-character escaping;
- chunked HTML escaping with a fast path for text that needs none;
- templates rendered into a shared string array, with `for` scopes reused
  across elements.

`main.ts` is the driver the harness runs: it reads every case from
`/input/cases.json`, answers each with `run`, and writes
`/output/answers.json`.
