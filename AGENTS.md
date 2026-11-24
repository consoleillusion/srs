# Working on SRS

The design book in `design/` is the source of truth for this project: goals,
stack, architecture, the security protocol, the roadmap, and the rules for
changes. Read its Typst source directly; you do not need to build the PDF.

Start here, in order:

1. `design/introduction.typ` — what the book governs and how to read it.
2. `design/goals.typ` and `design/stack.typ` — direction and required libraries.
3. `design/contributing.typ` — how to pick a task, conventions, security rules,
   and the definition of done.
4. `design/roadmap.typ` — pick the first task marked **Next**.
5. The chapters that task cites, and `design/status.typ` for known gaps.

Every change must pass:

```sh
bun install --frozen-lockfile
bun run typecheck
bun run test
bun run audit
bun run docs:check
bun run design
```

Protocol conformance fixtures are generated, never edited:
`pip install cryptography pynacl && python3 conformance/tools/generate.py`.

When a task is done, update `design/roadmap.typ` (state and status lines) in
the same change. Design rules change only with a new row in
`design/decisions.typ`. If the book does not settle a question, record it in
`design/status.typ` under open questions and ask the maintainer instead of
guessing.
