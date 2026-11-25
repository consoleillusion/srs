// The srs logotype and brand colours (@ref-branding). Imported by book.typ
// and by the branding chapter, so the rules and the title page stay the same.

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
