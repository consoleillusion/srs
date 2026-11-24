# SRS design book

The source of truth for SRS: goals, stack, architecture, the security
protocol, the roadmap, and the rules for working on the project. Written in
[Typst](https://typst.app), one file per chapter, joined by `book.typ`.

```bash
./design/build.sh           # writes design/book.pdf
./design/build.sh --watch   # rebuilds on save
bun run design              # same as the first line
```

`build.sh` uses the `typst` command if installed, otherwise the `typst` Python
package.

| Part | Chapters |
| --- | --- |
| I. Project | `introduction`, `goals`, `stack`, `architecture` |
| II. Data and API | `schema`, `migrations`, `authored-views`, `access-control`, `http-api` |
| III. Security | `threat-model`, `transport`, `accounts`, `requests`, `lifecycle`, `external-identity` |
| IV. Delivery | `operations`, `implementation`, `roadmap` |
| V. Working on SRS | `contributing`, `layout`, `decisions`, `status` |
| VI. Reference | `ref-schema`, `ref-data-model`, `ref-api`, `ref-auth`, `ref-deployment`, `ref-development` |

Contributors and agents: start with [AGENTS.md](../AGENTS.md). The generated
API reference is written to `doc/` by `bun run docs`.
