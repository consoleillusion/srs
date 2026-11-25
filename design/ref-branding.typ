#import "brand.typ": logo, night, brand-gray, brand-light, night-quiet, brand-gray-on-light

== Branding <ref-branding>

Status: *Implemented* on the title page of this book.

=== The logotype

#block(fill: night, inset: (x: 28pt, y: 24pt), radius: 3pt, width: 100%)[
  #logo(size: 72pt)
]
#block(fill: white, inset: (x: 28pt, y: 24pt), radius: 3pt, width: 100%, stroke: 0.5pt + luma(220))[
  #logo(size: 72pt, dark: false)
]

When srs is shown as a brand, on a title page, a logo, an icon or a banner, it
is set:

- in *lowercase*: `srs`, never `SRS` or `Srs`;
- in a *sans serif*, at its *heaviest weight* (black, 900);
- in *italic*;
- *partly gray*: the final "s" is gray, the other letters are not.

The typeface is Inter Display Black Italic, with Inter, DM Sans and Fira Sans as
fallbacks (`design/brand.typ`).

=== What each choice says

- *Thickness* is stability and robustness.
- *Italics* are speed and performance.
- *Sans serif* is modern, unobtrusive and unadorned.
- *Lowercase* is simplicity and ease of use.
- *Gray* is a background colour that goes with anything, as srs serves stably
  and reliably in the background. The gray letter is the last "s", for server.

=== Colours

#table(
  columns: (auto, auto, 1fr),
  table.header([*Use*], [*Colour*], [*Notes*]),
  [Dark background], [`#111111`], [The title page.],
  [Letters "sr" on dark], [`#ece6d8`], [Warm off-white.],
  [Letter "s" on dark], [`#888888`], [5.3:1 on `#111111`: WCAG AAA for large text, which the logotype always is.],
  [Small text on dark], [`#a6a6a6`], [7.7:1 on `#111111`: AAA at any size, for the lines around the logotype.],
  [Letters "sr" on light], [`#111111`], [],
  [Letter "s" on light], [`#767676`], [4.5:1 on white: AA at any size, so it stays readable when the logo is small.],
)

=== The title page

The logotype stands alone in the lower left, between two small lines: the
name, _Standard Resource Server_, above, and what the document is below (here,
_Design: goals, rules, protocol and roadmap_). The word "design", or any other
document name, never sits beside the logotype as part of it.

=== In running text

These rules are for branding only. In writing, including this book, code
comments, the README and messages, the project is written plainly in the
surrounding text's own style: SRS, or Standard Resource Server. Setting it in
heavy gray italics inside a sentence would be distracting and unlike any
other name.
