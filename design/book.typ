// SRS design book. Build with ./build.sh (writes book.pdf beside this file).

#set document(title: "SRS design", author: "SRS")
#set page(paper: "a4", margin: (x: 2.2cm, y: 2.4cm), numbering: "1")
#set text(size: 10.5pt)
#set par(justify: true)
#set heading(numbering: "1.1")
#set table(inset: 6pt, stroke: 0.5pt + luma(180))
#show table.cell.where(y: 0): set text(weight: "bold")
#show raw.where(block: true): block.with(
  fill: luma(245), inset: 8pt, radius: 3pt, width: 100%,
)
#show raw: set text(size: 9pt)
#show heading.where(level: 1): it => {
  pagebreak(weak: true)
  it
}

#align(center + horizon)[
  #text(size: 26pt, weight: "bold")[SRS design]
  #v(0.6em)
  #text(size: 13pt)[Goals, rules and protocol for the Secure Resource Server]
]

#pagebreak()
#outline(depth: 2)

#include "introduction.typ"
#include "goals.typ"
#include "architecture.typ"
#include "schema.typ"
#include "migrations.typ"
#include "authored-views.typ"
#include "access-control.typ"
#include "http-api.typ"
#include "threat-model.typ"
#include "transport.typ"
#include "accounts.typ"
#include "requests.typ"
#include "lifecycle.typ"
#include "external-identity.typ"
#include "operations.typ"
#include "decisions.typ"
#include "status.typ"
