#!/usr/bin/env python3
"""Draw the rich menu images from the definitions the API actually uses.

The tap targets live in `apps/api/src/rich-menu.ts`; the picture lives here. They
are two files describing one panel, so they can drift — a label renamed in the
code and not in the image is a button that says one thing and opens another. The
renderer therefore writes `manifest.json` beside the PNGs, and
`rich-menu.test.ts` fails when the manifest and the definitions disagree.

WHY CHROME AND NOT PIL. Pillow has no complex-text shaping (no Raqm in the wheel
this machine has), so Thai renders with the dotted-circle placeholder where a
vowel or tone mark should sit on its consonant — `วิเคราะห์` came out as
`ว◌ิเคราะห์`. Chrome shapes Thai correctly, so the HTML is rendered by headless
Chrome at exactly the image size. That makes this a local, one-off step: the PNGs
are committed, and nothing in CI or the container needs a browser.

Input: the JSON that `apps/api/scripts/render-rich-menus.ts` prints, on stdin.
Output: <out-dir>/<key>.png and <out-dir>/manifest.json

    pnpm --filter @laundrytwin/api exec tsx scripts/render-rich-menus.ts \
      | python3 deploy/line/render-rich-menus.py deploy/line/rich-menus
"""

import json
import os
import subprocess
import sys
import tempfile

from PIL import ImageFont

CHROME_CANDIDATES = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
]

# Used only to estimate how wide a label is, so the font size can be chosen
# before Chrome draws it. Shaping does not change the advance much.
MEASURE_FONT = [
    ("/System/Library/Fonts/Thonburi.ttc", 1),
    ("/usr/share/fonts/truetype/noto/NotoSansThai-Bold.ttf", 0),
    ("/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf", 0),
]

CANVAS = "#eef0f3"
TEXT = "#ffffff"

# The same glyphs the web app uses in its own navigation where one exists, so the
# panel and the app look like one product. 24x24 viewBox, drawn with a stroke.
ICONS = {
    "grid": '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/>'
    '<rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
    "chart": '<path d="M4 19V5"/><path d="M4 19h17"/><path d="m7 15 3-4 3 2 5-7"/>',
    # A drum inside a cabinet reads as "washing machine" at a glance; the app's
    # line-panel icon does not at this size.
    "washer": '<rect x="4" y="3" width="16" height="18" rx="2.5"/><circle cx="12" cy="13" r="4.2"/>'
    '<path d="M7.5 6.5h.01M10.5 6.5h.01"/>',
    "shield": '<path d="M12 3.2 5 6v6c0 4.2 2.9 7.4 7 8.8 4.1-1.4 7-4.6 7-8.8V6z"/>'
    '<path d="m9 12 2.2 2.2L15.5 10"/>',
    "wrench": '<path d="M14.7 6.3a4 4 0 0 0 5 5l-9.4 9.4a2.1 2.1 0 0 1-3-3z"/><path d="m6 6 3 3"/>',
    "chat": '<path d="M20 12a7 7 0 0 1-7 7H8l-4 3v-4.6A7 7 0 0 1 4 12a7 7 0 0 1 7-7h2a7 7 0 0 1 7 7z"/>'
    '<path d="M9 12h.01M12.5 12h.01M16 12h.01"/>',
    "key": '<circle cx="8" cy="12" r="3.5"/><path d="M11.5 12H21"/><path d="M18 12v3.5"/><path d="M15 12v2.5"/>',
}


def chrome() -> str:
    for path in CHROME_CANDIDATES:
        if os.path.exists(path):
            return path
    raise SystemExit("no Chrome/Chromium found; add one to CHROME_CANDIDATES")


def measure(text: str, size: int) -> float:
    for path, index in MEASURE_FONT:
        if os.path.exists(path):
            font = ImageFont.truetype(path, size, index=index)
            return font.getlength(text)
    return len(text) * size * 0.6


# Pillow measures Thai without shaping, so every vowel and tone mark counts as a
# full advance and the width comes out roughly a fifth too wide. Chrome, which
# draws the image, stacks those marks on their consonant.
SHAPING_CORRECTION = 0.82


def font_size_for(label: str, tile_width: int) -> int:
    """Largest size at which the label fits its tile, capped so it stays calm."""
    available = tile_width - 36
    size = 104
    while size > 24 and measure(label, size) * SHAPING_CORRECTION > available:
        size -= 2
    return size


def build_html(menu: dict, width: int, height: int) -> str:
    count = len(menu["areas"])
    column = width // count
    tile_width = column - 28
    tile_height = height - 28

    # One label size for the whole panel: per-tile sizing made "ภาพรวม" twice the
    # height of "เครื่องซักผ้า" and the panel read as unrelated buttons.
    size = min(font_size_for(label, tile_width) for label in menu["labels"])
    # The icons carry the panel: at 0.5 of the tile they read as decoration above
    # a label rather than as the button itself.
    icon_size = int(min(tile_width * 0.66, tile_height * 0.52))

    tiles = []
    for index in range(count):
        icon = ICONS[menu["icons"][index]]
        tiles.append(
            f'<div class="tile" style="width:{tile_width}px;height:{tile_height}px;'
            f'background:{menu["colors"][index]}">'
            f'<svg viewBox="0 0 24 24" width="{icon_size}" height="{icon_size}" fill="none" '
            f'stroke="{TEXT}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">'
            f"{icon}</svg>"
            f'<div class="label" style="font-size:{size}px">{menu["labels"][index]}</div>'
            f"</div>"
        )

    return f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  html, body {{ width:{width}px; height:{height}px; background:{CANVAS}; overflow:hidden; }}
  body {{ display:flex; align-items:center; justify-content:flex-start;
         font-family:"Thonburi","Noto Sans Thai",sans-serif; }}
  .tile {{ margin:14px; border-radius:34px; display:flex; flex-direction:column;
           align-items:center; justify-content:center; gap:26px; }}
  .label {{ color:{TEXT}; font-weight:700; white-space:nowrap; letter-spacing:0.4px; }}
</style></head><body>{"".join(tiles)}</body></html>"""


def render(menu: dict, width: int, height: int, out_path: str) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        html_path = os.path.join(tmp, "menu.html")
        with open(html_path, "w") as handle:
            handle.write(build_html(menu, width, height))
        subprocess.run(
            [
                chrome(),
                "--headless=new",
                "--disable-gpu",
                "--hide-scrollbars",
                "--force-device-scale-factor=1",
                f"--window-size={width},{height}",
                f"--screenshot={out_path}",
                f"file://{html_path}",
            ],
            check=True,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
        )


def main() -> None:
    if len(sys.argv) != 2:
        raise SystemExit("usage: render-rich-menus.py <out-dir>")
    out_dir = sys.argv[1]
    spec = json.load(sys.stdin)
    width, height = spec["size"]["width"], spec["size"]["height"]
    os.makedirs(out_dir, exist_ok=True)

    manifest = {"size": spec["size"], "menus": []}
    for menu in spec["menus"]:
        path = os.path.join(out_dir, f"{menu['key']}.png")
        render(menu, width, height, path)
        manifest["menus"].append(
            {
                "key": menu["key"],
                "name": menu["name"],
                "chatBarText": menu["chatBarText"],
                "labels": menu["labels"],
                "icons": menu["icons"],
                "areas": menu["areas"],
                "file": os.path.basename(path),
                "bytes": os.path.getsize(path),
            }
        )
        print(f"{path}  {os.path.getsize(path)} bytes  {len(menu['areas'])} areas")

    with open(os.path.join(out_dir, "manifest.json"), "w") as handle:
        json.dump(manifest, handle, ensure_ascii=False, indent=2)
        handle.write("\n")


if __name__ == "__main__":
    main()
