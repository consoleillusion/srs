// The srs logotype and brand colours (@ref-branding). Imported by book.typ
// and by the branding chapter, so the rules and the title page stay the same.

/// Background of the title page and of the logotype's dark form.
#let night = rgb("#111111")
/// The gray of the final "s": the server, in the background.
#let brand-gray = rgb("#888888")
/// The warm off-white of the other letters on a dark background.
#let brand-light = rgb("#ece6d8")
/// Small text on the dark background, at AAA contrast (7.7:1 on night).
#let night-quiet = rgb("#a6a6a6")
/// The gray of the final "s" on a light background (4.6:1 on white).
#let brand-gray-on-light = rgb("#767676")

/// The heavy italic sans the logotype is set in, with fallbacks.
#let brand-font = ("Inter Display", "Inter", "DM Sans", "Fira Sans")

/// The srs logotype: lowercase, black weight, italic, the final "s" in gray.
///
/// - size (length): Font size.
/// - dark (bool): True on a dark background, false on a light one.
#let logo(size: 96pt, dark: true) = text(
  font: brand-font, weight: 900, style: "italic", size: size, tracking: -0.03em,
  // Lowercase only: measure from the x-height, so the space around it is even.
  top-edge: "x-height", bottom-edge: "baseline",
)[#text(fill: if dark { brand-light } else { night })[sr]#text(fill: if dark { brand-gray } else { brand-gray-on-light })[s]]
