// SRS design book. Build with ./build.sh or `bun run design` (writes ../dist/srs.pdf).
// Markdown chapters in this directory are the source; this file holds the
// brand, layout and chapter order, and renders the chapters into the PDF.

#import "@preview/cmarker:0.1.10": render

// ── Brand ───────────────────────────────────────────────────────────────
// The srs logotype and brand colours (@ref-branding). Kept here so the rules
// and the title page stay the same.

/// Background of the title page and of the logotype's dark form.
#let night = rgb("#111111")
/// The gray of the logotype, and of small text, on a dark background (7.7:1 on night: AAA at any size).
#let brand-gray = rgb("#a6a6a6")
/// Text on the dark background other than the logotype.
#let brand-light = rgb("#ece6d8")
/// Small quiet text on the dark background.
#let night-quiet = brand-gray
/// The gray of the logotype on a light background (4.5:1 on white: AA at any size).
#let brand-gray-on-light = rgb("#767676")

/// The heavy italic sans the logotype is set in, with fallbacks.
#let brand-font = ("Inter Display", "Inter", "DM Sans", "Fira Sans")

/// The srs logotype: lowercase, black weight, italic, all one gray.
///
/// - size (length): Font size.
/// - dark (bool): True on a dark background, false on a light one.
#let logo(size: 96pt, dark: true) = text(
  font: brand-font, weight: 900, style: "italic", size: size, tracking: -0.03em,
  // Lowercase only: measure from the x-height, so the space around it is even.
  top-edge: "x-height", bottom-edge: "baseline",
  fill: if dark { brand-gray } else { brand-gray-on-light },
)[srs]

// ── Palette ────────────────────────────────────────────────────────────
//#let bone = rgb("#f3eee3")
#let bone = rgb("#f1f1f1")
#let ink = rgb(28, 24, 20).transparentize(10%)
#let muted = rgb(28, 24, 20).transparentize(48%)
#let rule = rgb(28, 24, 20).transparentize(80%)
#let shade = rgb("#e9e2d3")
#let accent = rgb("#7a2e1d").transparentize(8%)
#let paper-light = rgb("#ece6d8").transparentize(12%)

#let sans = ("Inter", "Source Sans 3", "Fira Sans", "Noto Sans", "DejaVu Sans", "Liberation Sans", "Arial")

// ── Document and page ──────────────────────────────────────────────────
#set document(title: "SRS design", author: "SRS")
#set page(
  paper: "a4",
  fill: bone,
  margin: 2.5cm,
  header: context {
    let page-no = here().page()
    let starts = query(heading.where(level: 1).or(heading.where(level: 2)))
      .filter(h => h.location().page() == page-no)
    let chapters = query(heading.where(level: 2).before(here()))
    if starts.len() == 0 and chapters.len() > 0 {
      set text(size: 8pt, fill: muted)
      align(right, chapters.last().body)
    }
  },
  footer: context {
    set text(size: 8pt, fill: muted)
    align(center, counter(page).display())
  },
)

#set text(font: sans, size: 10.5pt, fill: ink, lang: "en", hyphenate: false)
#set par(justify: false, leading: 0.72em, spacing: 1.25em)
#set list(indent: 0.4em, body-indent: 0.6em, spacing: 0.85em, marker: text(fill: muted)[•])
#set enum(indent: 0.4em, body-indent: 0.6em, spacing: 0.85em)
#show strong: set text(weight: 600)
#show link: set text(fill: accent)

// ── Code ───────────────────────────────────────────────────────────────
#show raw: set text(size: 8.8pt)
#show raw.where(block: true): it => block(
  fill: shade, inset: (x: 12pt, y: 10pt), radius: 4pt, width: 100%,
  above: 1.4em, below: 1.4em, it,
)
#show raw.where(block: false): it => box(
  fill: shade, inset: (x: 2.5pt), outset: (y: 2.5pt), radius: 2pt, it,
)

// ── Tables ─────────────────────────────────────────────────────────────
#set table(
  inset: (x: 7pt, y: 7pt),
  stroke: (_, y) => if y == 0 { (bottom: 0.8pt + muted) } else { (bottom: 0.4pt + rule) },
  fill: (_, y) => if y == 0 { shade },
)
#show table: set text(size: 9.6pt)
#show table: set par(leading: 0.62em)
#show table: it => block(above: 1.4em, below: 1.6em, it)

// ── Headings: parts (level 1), chapters (2), sections (3), subsections (4)
#set heading(numbering: none)

// A title group: a small line above a large one, with a small line below,
// set close together because they read as one unit.
#let title-group(above, title, below, size: 34pt, quiet: muted) = {
  set text(top-edge: "cap-height", bottom-edge: "baseline")
  set par(spacing: 0pt)
  stack(
    spacing: 14pt,
    text(size: 12pt, weight: 600, above),
    text(size: size, weight: 300, title),
    if below != none { block(width: 75%, text(size: 12pt, fill: quiet, below)) },
  )
}

#show heading.where(level: 1): it => block(text(weight: 300, it.body))

#show heading.where(level: 2): it => {
  pagebreak(weak: true)
  v(0.4cm)
  block(below: 1.6em, text(size: 24pt, weight: 500, it.body))
}

#show heading.where(level: 3): it => block(
  above: 2.4em, below: 1em, sticky: true,
  text(size: 13.5pt, weight: 600, it.body),
)

#show heading.where(level: 4): it => block(
  above: 1.6em, below: 0.7em, sticky: true,
  text(size: 11pt, weight: 600, it.body),
)

// References to unnumbered headings show the heading's title as a link.
#show ref: it => {
  let target = it.element
  if target != none and target.func() == heading {
    link(target.location(), target.body)
  } else {
    it
  }
}

// ── Parts ──────────────────────────────────────────────────────────────
#let part(numeral, title, summary) = page(header: none, footer: none)[
  #v(1fr)
  #title-group([Part #numeral], heading(level: 1, supplement: [Part #numeral], title), summary)
  #v(1.4fr)
]

// ── Contents ───────────────────────────────────────────────────────────
#show outline: it => {
  show link: set text(fill: ink)
  it
}
#show outline.entry.where(level: 1): it => {
  v(1.3em, weak: true)
  link(it.element.location(), text(weight: 600)[
    #it.element.supplement #h(0.6em) #it.element.body #h(1fr) #it.page()
  ])
}
#show outline.entry.where(level: 2): it => {
  v(0.55em, weak: true)
  it
}

// ── Title page ─────────────────────────────────────────────────────────
#page(header: none, footer: none, fill: night)[
  #set text(fill: brand-light)
  #place(bottom + left, {
    set par(spacing: 0pt)
    stack(
      spacing: 16pt,
      text(size: 12pt, weight: 600)[Standard Resource Server],
      logo(size: 112pt),
      text(size: 12pt, fill: night-quiet)[Design: goals, rules, protocol and roadmap],
    )
  })
]

#page(header: none)[
  #v(0.4cm)
  #text(size: 24pt, weight: 500)[Contents]
  #v(1.2em)
  #outline(title: none, depth: 2, indent: 1.4em)
]

// ── Book ───────────────────────────────────────────────────────────────
// Markdown `#` headings become Typst level 2, so chapters sit under parts.
// Prefix cmarker's automatic heading labels so they cannot collide with the
// raw labels used for cross-references.
#let chapter(name) = render(
  read(name + ".md"),
  h1-level: 2,
  label-prefix: "chapter-",
  prefix-label-uses: false,
)

#part("I", "Project",
  [What SRS is for, what it is built with, and how its parts fit together.])
#chapter("why")
#chapter("introduction")
#chapter("goals")
#chapter("stack")
#chapter("architecture")

#part("II", "Data and API",
  [How schema becomes tables, migrations, views, access rules and routes.])
#chapter("schema")
#chapter("migrations")
#chapter("authored-views")
#chapter("existing-databases")
#chapter("access-control")
#chapter("http-api")

#part("III", "Security",
  [The attacker model, and the protocol that keeps SRS secure without TLS.])
#chapter("threat-model")
#chapter("transport")
#chapter("accounts")
#chapter("requests")
#chapter("lifecycle")
#chapter("encryption")

#part("IV", "Delivery",
  [Running SRS, the order it is built in, and the work that remains.])
#chapter("operations")
#chapter("implementation")
#chapter("roadmap")

#part("V", "Working on SRS",
  [Rules for contributors and agents, where things live, the decisions made, and where the project stands.])
#chapter("contributing")
#chapter("layout")
#chapter("decisions")
#chapter("status")

#part("VI", "Reference",
  [The schema keywords, data model, API, authentication routes, deployment settings, development commands, the console and the brand.])
#chapter("ref-schema")
#chapter("ref-data-model")
#chapter("ref-api")
#chapter("ref-auth")
#chapter("ref-deployment")
#chapter("ref-development")
#chapter("ref-console")
#chapter("ref-branding")
