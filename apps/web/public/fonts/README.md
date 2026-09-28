# Vendored web fonts

`noto-sans-thai-subset.woff2` is served by the app at `/fonts/noto-sans-thai-subset.woff2`.
It exists so the header's nav-collapse breakpoint in `apps/web/src/styles.css` measures the
same pixels on every machine instead of resolving to whatever Thai-capable font the host
happens to have installed. See `../../src/styles.css` for the `@font-face` declaration and
`../../DESIGN.md` for the measurement rule.

## Source

| | |
|---|---|
| Family | Noto Sans Thai |
| Version | 2.002 (name table ID 5) |
| Upstream | `https://github.com/notofonts/notofonts.github.io` |
| File taken | `fonts/NotoSansThai/full/variable/NotoSansThai[wdth,wght].ttf` |
| Raw URL | `https://raw.githubusercontent.com/notofonts/notofonts.github.io/main/fonts/NotoSansThai/full/variable/NotoSansThai%5Bwdth%2Cwght%5D.ttf` |
| Upstream SHA-256 | `e9002f580ce972c2c6c7a6ab80c4eedf60989ddbab5be188f1273054464d8ebf` |
| Licence | SIL Open Font License 1.1 — full text in `OFL.txt` |

Upstream file last changed in that repository on 2023-09-27, so `2.002` is current.

## How the subset was produced

```sh
# Drop the width axis (the app never sets font-stretch) and keep the full
# 100-900 weight axis, so 700/800/900 all render as themselves rather than
# being clamped or synthesised.
fonttools varLib.instancer NotoSansThai[wdth,wght].ttf wdth=100 -o NotoSansThai-wght.ttf

fonttools subset NotoSansThai-wght.ttf \
  --unicodes="U+0000-00FF,U+2000-206F,U+20A0-20BF,U+0E00-0E7F" \
  --layout-features='*' --name-IDs='*' --name-legacy --name-languages='*' \
  --notdef-glyph --notdef-outline --recommended-glyphs \
  --flavor=woff2 --output-file=noto-sans-thai-subset.woff2
```

## Coverage and size

| | Bytes |
|---|---|
| Upstream variable TTF (both axes) | 221,012 |
| After dropping the `wdth` axis (TTF) | 121,732 |
| **Shipped subset (woff2, `wght` 100-900)** | **53,584** |

Kept: Basic Latin, Latin-1 Supplement, General Punctuation, Currency Symbols, and the
**entire** Unicode Thai block `U+0E00-U+0E7F`. All 87 assigned Thai codepoints are present,
so Thai is zero-tofu by construction rather than by luck — the repo requires no missing
glyphs on screen. Every Thai combining mark (`U+0E31`, `U+0E34-U+0E3A`, `U+0E47-U+0E4E`)
is in range, and `--layout-features='*'` keeps the GPOS mark-attachment and the Thai
`SARA AM` (`U+0E33`) decomposition/ligature tables, so tone marks and vowels stay stacked
above their base consonant instead of drifting.

Deliberately out of range, and therefore per-glyph falling through to the next family in
the stack rather than to tofu:

- `U+2190` LEFTWARDS ARROW, used in the back link on `/terms` and `/privacy`. It is not a
  Thai-block glyph and Noto Sans Thai has never included it.
- `U+20B1` BAHT SIGN. The app writes baht as `U+0E3F` (`฿`), which *is* in range.
- `U+0E00` and `U+0E7F` are unassigned in Unicode and appear only inside a test regex
  (`apps/web/src/lib/machine-status.test.ts`), never in rendered output.

If Thai copy ever needs a codepoint outside `U+0E00-U+0E7F`, widen `--unicodes` and
re-run the command above rather than relying on fallback.
