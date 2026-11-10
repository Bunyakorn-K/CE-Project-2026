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
import shutil
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

BACKGROUND = "#0d1117"
DIVIDER = "#30363d"
TEXT = "#f0f6fc"


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
# draws the image, stacks those marks on their consonant. Without this correction
# the longest label shrinks the whole panel to about half the size it could be.
SHAPING_CORRECTION = 0.82


def font_size_for(label: str, column_width: int) -> int:
    """Largest size at which the label fits, capped so short labels stay calm."""
    available = column_width - 48
    size = 150
    while size > 28 and measure(label, size) * SHAPING_CORRECTION > available:
        size -= 4
    return size


def build_html(menu: dict, width: int, height: int) -> str:
    # One size for the whole panel: the largest that fits the longest label. Per
    # column sizing made "ภาพรวม" twice the height of "เครื่องซักผ้า" and the panel
    # read as four unrelated buttons.
    size = min(
        font_size_for(menu["labels"][index], area["bounds"]["width"])
        for index, area in enumerate(menu["areas"])
    )
    columns = []
    for index, area in enumerate(menu["areas"]):
        bounds = area["bounds"]
        label = menu["labels"][index]
        border = f"border-left:2px solid {DIVIDER};" if index > 0 else ""
        columns.append(
            f'<div class="col" style="width:{bounds["width"]}px;{border}">'
            f'<div class="strip" style="background:{menu["accent"]}"></div>'
            f'<div class="label" style="font-size:{size}px">{label}</div>'
            f"</div>"
        )
    return f"""<!doctype html>
<html><head><meta charset="utf-8"><style>
  * {{ margin:0; padding:0; box-sizing:border-box; }}
  html, body {{ width:{width}px; height:{height}px; background:{BACKGROUND}; overflow:hidden; }}
  body {{ display:flex; font-family:"Thonburi","Noto Sans Thai",sans-serif; }}
  .col {{ position:relative; height:{height}px; display:flex; align-items:center; justify-content:center; }}
  .strip {{ position:absolute; top:0; left:0; right:0; height:10px; }}
  .label {{ color:{TEXT}; font-weight:700; white-space:nowrap; letter-spacing:0.5px; }}
</style></head><body>{"".join(columns)}</body></html>"""


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
