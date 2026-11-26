# Working on SRS

The design book in `design/` is the source of truth for this project: goals,
stack, architecture, the security protocol, the roadmap, and the rules for
changes. The chapters are Markdown files; read them directly, you do not need
to build the PDF.

Start here, in order:

1. `design/introduction.md` — what the book governs and how to read it.
2. `design/goals.md` and `design/stack.md` — direction and required libraries.
3. `design/contributing.md` — how to pick a task, conventions, security rules,
   and the definition of done.
4. `design/roadmap.md` — pick the first task marked **Next**.
5. The chapters that task cites, and `design/status.md` for known gaps.

`design/index.typ` is the only Typst source: it holds the brand and layout and
renders the Markdown chapters into `dist/srs.pdf`.

Every change must pass:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run audit
bun run docs:check
bun run design
```

Protocol conformance fixtures in `conformance/` are frozen files: change one
only when the behaviour it pins changes.

When a task is done, update `design/roadmap.md` (state and status lines) in
the same change. Design rules change only with a new row in
`design/decisions.md`. If the book does not settle a question, record it in
`design/status.md` under open questions and ask the maintainer instead of
guessing.
