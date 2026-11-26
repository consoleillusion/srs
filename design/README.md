# SRS design book

The source of truth for SRS: goals, stack, architecture, the security
protocol, the roadmap, and the rules for working on the project. Each chapter
is a Markdown file in this directory; `index.typ` is the single Typst
entry point that holds the brand and layout and renders the chapters into a
PDF.

```bash
./design/build.sh           # writes dist/srs.pdf
./design/build.sh --watch   # rebuilds on save
bun run design              # same as the first line
```

`build.sh` uses the installed `typst` command. It passes
`~/.local/share/fonts/srs-brand` as the font path so the logo uses the brand
fonts; set `SRS_FONT_PATH` to override it. Chapter links use raw Typst labels
after their headings (`<!--raw-typst <label> -->`) so cross-references work in
the PDF.

| Part | Chapters |
| --- | --- |
| I. Project | `why`, `introduction`, `goals`, `stack`, `architecture` |
| II. Data and API | `schema`, `migrations`, `authored-views`, `existing-databases`, `access-control`, `http-api` |
| III. Security | `threat-model`, `transport`, `accounts`, `requests`, `lifecycle`, `encryption` |
| IV. Delivery | `operations`, `implementation`, `roadmap` |
| V. Working on SRS | `contributing`, `layout`, `decisions`, `status` |
| VI. Reference | `ref-schema`, `ref-data-model`, `ref-api`, `ref-auth`, `ref-deployment`, `ref-development`, `ref-console`, `ref-branding` |

Contributors and agents: start with [AGENTS.md](../AGENTS.md). The generated
API reference is written to `doc/` by `bun run docs`.
