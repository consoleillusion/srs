# SRS design

The design book records SRS's goals, rules, security protocol and decision
log. It is written in [Typst](https://typst.app): one file per section, joined
by `book.typ`.

```bash
./design/build.sh           # writes design/book.pdf
./design/build.sh --watch   # rebuilds on save
bun run design              # same as the first line
```

`build.sh` uses the `typst` command if installed, otherwise the `typst` Python
package.

The reference documentation for what is built today is in [doc](../doc/README.md).
