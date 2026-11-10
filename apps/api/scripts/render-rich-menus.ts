// Prints the rich menu spec as JSON, for deploy/line/render-rich-menus.py.
//
// The definitions live in src/rich-menu.ts and are the same ones the sync uploads,
// so the picture and the tap targets cannot be built from different sources. The
// LIFF id only affects the URIs, which the renderer ignores — a placeholder is
// used so this runs without the deployment's configuration.
import { RICH_MENU_IMAGE, richMenuDefinitions } from "../src/rich-menu";

const definitions = richMenuDefinitions("0000000000-placeholder");

process.stdout.write(
  JSON.stringify(
    {
      size: RICH_MENU_IMAGE,
      menus: definitions.map((definition) => ({
        key: definition.key,
        name: definition.name,
        chatBarText: definition.chatBarText,
        accent: definition.accent,
        labels: definition.labels,
        icons: definition.icons,
        colors: definition.colors,
        areas: definition.areas
      }))
    },
    null,
    2
  )
);
