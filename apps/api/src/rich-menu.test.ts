import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  HERO_HEIGHT_RATIO,
  RICH_MENU_IMAGE,
  RICH_MENU_SIZES,
  heroBounds,
  rowBounds,
  RICH_MENU_PREFIX,
  buildRichMenuObject,
  columnBounds,
  liffUri,
  linkMenuForUser,
  menuKeyForRoles,
  richMenuDefinitions,
  syncRichMenus,
  type RichMenuApi,
  type RichMenuKey
} from "./rich-menu";

const LIFF_ID = "2011592166-uToRdTwS";

function fakeApi(existing: { richMenuId: string; name: string }[] = []) {
  const calls: string[] = [];
  const api: RichMenuApi = {
    createRichMenu: vi.fn(async (body: unknown) => {
      const name = (body as { name: string }).name;
      calls.push(`create:${name}`);
      return { richMenuId: `menu-${name.split(":")[1]}` };
    }),
    setRichMenuImage: vi.fn(async (id: string) => {
      calls.push(`image:${id}`);
    }),
    setDefaultRichMenu: vi.fn(async (id: string) => {
      calls.push(`default:${id}`);
    }),
    linkRichMenuIdToUser: vi.fn(async (userId: string, id: string) => {
      calls.push(`link:${userId}:${id}`);
    }),
    getRichMenuList: vi.fn(async () => ({ richmenus: existing })),
    deleteRichMenu: vi.fn(async (id: string) => {
      calls.push(`delete:${id}`);
    })
  };
  return { api, calls };
}

const images = {
  owner: Buffer.from("owner"),
  manager: Buffer.from("manager"),
  technician: Buffer.from("technician"),
  default: Buffer.from("default")
} as Record<RichMenuKey, Buffer>;

describe("columnBounds", () => {
  it("covers the image exactly, with no gap and no overlap", () => {
    for (const count of [1, 2, 3, 4]) {
      const bounds = Array.from({ length: count }, (_, index) => columnBounds(index, count));
      expect(bounds[0].x).toBe(0);
      const last = bounds[bounds.length - 1];
      expect(last.x + last.width).toBe(RICH_MENU_IMAGE.width);
      for (let i = 1; i < bounds.length; i += 1) {
        expect(bounds[i].x).toBe(bounds[i - 1].x + bounds[i - 1].width);
      }
      for (const bound of bounds) {
        expect(bound.y).toBe(0);
        expect(bound.height).toBe(RICH_MENU_IMAGE.height);
      }
    }
  });

  it("refuses an index outside the row", () => {
    expect(() => columnBounds(3, 3)).toThrow();
    expect(() => columnBounds(0, 0)).toThrow();
  });
});

describe("heroBounds", () => {
  const size = RICH_MENU_SIZES.tall;

  it("puts one full-width tile on top and the rest in a row beneath", () => {
    const count = 5;
    const bounds = Array.from({ length: count }, (_, index) => heroBounds(index, count, size));

    expect(bounds[0]).toEqual({
      x: 0,
      y: 0,
      width: size.width,
      height: Math.round(size.height * HERO_HEIGHT_RATIO)
    });

    // The row below starts where the hero ends and its tiles sit side by side.
    for (const bound of bounds.slice(1)) {
      expect(bound.y).toBe(bounds[0].height);
      expect(bound.height).toBe(size.height - bounds[0].height);
    }
    for (let i = 2; i < bounds.length; i += 1) {
      expect(bounds[i].x).toBe(bounds[i - 1].x + bounds[i - 1].width);
    }
  });

  it("covers the image exactly — an uncovered strip shows the canvas through the panel", () => {
    for (const count of [2, 3, 4, 5, 6]) {
      const bounds = Array.from({ length: count }, (_, index) => heroBounds(index, count, size));
      const area = bounds.reduce((sum, bound) => sum + bound.width * bound.height, 0);
      expect(area).toBe(size.width * size.height);
      const last = bounds[bounds.length - 1];
      expect(last.x + last.width).toBe(size.width);
      expect(last.y + last.height).toBe(size.height);
    }
  });

  it("needs a tile beneath the hero", () => {
    expect(() => heroBounds(0, 1, size)).toThrow();
  });

  it("gives the owner the tall shape and a hero tile, and the others one row", () => {
    const definitions = richMenuDefinitions(LIFF_ID);
    const owner = definitions.find((definition) => definition.key === "owner");
    expect(owner?.layout).toBe("hero");
    expect(owner?.size).toEqual(RICH_MENU_SIZES.tall);
    expect(owner?.areas[0].bounds.width).toBe(RICH_MENU_SIZES.tall.width);
    expect(owner?.areas[0].action).toEqual({ type: "uri", uri: `https://liff.line.me/${LIFF_ID}/dashboard` });

    for (const definition of definitions.filter((entry) => entry.key !== "owner")) {
      expect(definition.layout).toBe("row");
      expect(definition.size).toEqual(RICH_MENU_SIZES.wide);
    }
  });
});

describe("rowBounds", () => {
  it("still splits the wide image into equal columns", () => {
    const bounds = Array.from({ length: 4 }, (_, index) => rowBounds(index, 4, RICH_MENU_SIZES.wide));
    expect(bounds[0].width).toBe(625);
    expect(bounds[3].x + bounds[3].width).toBe(RICH_MENU_SIZES.wide.width);
  });
});

describe("menuKeyForRoles", () => {
  it("gives the strongest grant, so a panel never hides a page the user may open", () => {
    expect(menuKeyForRoles(["technician", "owner"])).toBe("owner");
    expect(menuKeyForRoles(["technician", "manager"])).toBe("manager");
    expect(menuKeyForRoles(["technician"])).toBe("technician");
    expect(menuKeyForRoles([])).toBe("default");
  });
});

describe("richMenuDefinitions", () => {
  const definitions = richMenuDefinitions(LIFF_ID);

  it("defines one menu per role plus a fallback", () => {
    expect(definitions.map((definition) => definition.key)).toEqual([
      "owner",
      "manager",
      "technician",
      "default"
    ]);
  });

  it("keeps the bar label inside LINE's 14-character limit", () => {
    for (const definition of definitions) {
      expect(definition.chatBarText.length, definition.key).toBeLessThanOrEqual(14);
    }
  });

  it("gives every area a label and an action, in the same order", () => {
    for (const definition of definitions) {
      expect(definition.labels.length).toBe(definition.areas.length);
      for (const label of definition.labels) expect(label.trim()).not.toBe("");
      for (const area of definition.areas) {
        if (area.action.type === "uri") {
          expect(area.action.uri.startsWith(`https://liff.line.me/${LIFF_ID}/`)).toBe(true);
        } else {
          expect(area.action.text.trim()).not.toBe("");
        }
      }
    }
  });

  it("sends the owner to the backoffice and nobody else", () => {
    const owner = definitions.find((definition) => definition.key === "owner");
    const others = definitions.filter((definition) => definition.key !== "owner");
    const uris = (menu: typeof owner) =>
      (menu?.areas ?? []).flatMap((area) => (area.action.type === "uri" ? [area.action.uri] : []));
    expect(uris(owner).some((uri) => uri.endsWith("/admin"))).toBe(true);
    for (const menu of others) {
      expect(uris(menu).some((uri) => uri.includes("/admin"))).toBe(false);
    }
  });

  it("can start a conversation from every menu", () => {
    // A panel made only of links assumes the user already knows the bot answers
    // questions. One message action per menu is the way in — and a message the
    // user sends is answered with a free reply, so it costs nothing.
    for (const definition of definitions) {
      const messages = definition.areas.filter((area) => area.action.type === "message");
      expect(messages.length, `${definition.key} has no message action`).toBeGreaterThan(0);
    }
    const chat = definitions.map((definition) =>
      definition.areas.find((area) => area.action.type === "message" && area.action.text === "สวัสดี")
    );
    // The same opener in every menu, so the assistant hears one consistent start.
    for (const area of chat) expect(area).toBeDefined();
  });

  it("gives every area an icon and a tile colour", () => {
    for (const definition of definitions) {
      expect(definition.icons.length).toBe(definition.areas.length);
      expect(definition.colors.length).toBe(definition.areas.length);
      for (const color of definition.colors) expect(color).toMatch(/^#[0-9a-f]{6}$/i);
      for (const icon of definition.icons) expect(icon.trim()).not.toBe("");
    }
  });

  it("names every menu with the deployment prefix and a version", () => {
    for (const definition of definitions) {
      expect(definition.name.startsWith(RICH_MENU_PREFIX)).toBe(true);
      expect(definition.name).toMatch(/:v\d+$/);
    }
  });
});

describe("buildRichMenuObject", () => {
  it("produces the shape LINE's create endpoint expects", () => {
    const [owner] = richMenuDefinitions(LIFF_ID);
    const object = buildRichMenuObject(owner);
    // The owner panel is the tall shape; the object must declare that size or LINE
    // rejects the image it is given.
    expect(object.size).toEqual({ width: 2500, height: 1686 });
    expect(object.selected).toBe(true);
    expect(object.name).toBe(owner.name);
    expect(object.chatBarText).toBe(owner.chatBarText);
    expect(object.areas).toHaveLength(owner.areas.length);
    expect(object.areas[0]).toEqual({ bounds: owner.areas[0].bounds, action: owner.areas[0].action });
  });
});

describe("liffUri", () => {
  it("forwards the path to the LIFF endpoint", () => {
    expect(liffUri(LIFF_ID, "/dashboard")).toBe(`https://liff.line.me/${LIFF_ID}/dashboard`);
    expect(liffUri(LIFF_ID, "dashboard")).toBe(`https://liff.line.me/${LIFF_ID}/dashboard`);
  });
});

describe("syncRichMenus", () => {
  it("creates every menu, uploads its image, and makes the fallback the default", async () => {
    const { api, calls } = fakeApi();
    const result = await syncRichMenus(api, { liffId: LIFF_ID, images });

    expect(result.created).toHaveLength(4);
    expect(api.createRichMenu).toHaveBeenCalledTimes(4);
    expect(api.setRichMenuImage).toHaveBeenCalledTimes(4);
    expect(result.defaultId).toBe(result.ids.default);
    expect(calls).toContain(`default:${result.ids.default}`);
    // The image is uploaded for the menu that was just created, not another one.
    expect(calls).toContain(`image:${result.ids.owner}`);
  });

  it("deletes the menus it owned before, and nothing else", async () => {
    const { api } = fakeApi([
      { richMenuId: "old-owner", name: `${RICH_MENU_PREFIX}owner:v0` },
      { richMenuId: "old-default", name: `${RICH_MENU_PREFIX}default:v0` },
      { richMenuId: "someone-else", name: "handmade-menu" }
    ]);
    const result = await syncRichMenus(api, { liffId: LIFF_ID, images });

    expect(result.deleted.sort()).toEqual(["old-default", "old-owner"]);
    expect(api.deleteRichMenu).not.toHaveBeenCalledWith("someone-else");
  });

  it("creates before it deletes, so a failure leaves the old panel working", async () => {
    const { api, calls } = fakeApi([{ richMenuId: "old-owner", name: `${RICH_MENU_PREFIX}owner:v0` }]);
    await syncRichMenus(api, { liffId: LIFF_ID, images });
    expect(calls.indexOf("delete:old-owner")).toBeGreaterThan(calls.lastIndexOf("image:menu-owner"));
  });

  it("refuses to create a menu with no image", async () => {
    const { api } = fakeApi();
    await expect(
      syncRichMenus(api, { liffId: LIFF_ID, images: { ...images, technician: Buffer.alloc(0) } })
    ).rejects.toThrow(/no image for the technician menu/);
  });
});

describe("linkMenuForUser", () => {
  const ids = { owner: "m-owner", manager: "m-manager", technician: "m-tech", default: "m-default" };

  it("links the menu for the user's strongest role", async () => {
    const api = { linkRichMenuIdToUser: vi.fn(async () => undefined) };
    expect(await linkMenuForUser(api, "U1", ["technician"], ids)).toBe("technician");
    expect(api.linkRichMenuIdToUser).toHaveBeenCalledWith("U1", "m-tech");

    expect(await linkMenuForUser(api, "U2", ["manager", "owner"], ids)).toBe("owner");
    expect(api.linkRichMenuIdToUser).toHaveBeenLastCalledWith("U2", "m-owner");
  });

  it("falls back to the default menu for someone with no grant", async () => {
    const api = { linkRichMenuIdToUser: vi.fn(async () => undefined) };
    expect(await linkMenuForUser(api, "U3", [], ids)).toBe("default");
    expect(api.linkRichMenuIdToUser).toHaveBeenCalledWith("U3", "m-default");
  });
});

describe("the rendered images match the definitions", () => {
  // The picture is drawn by deploy/line/render-rich-menus.py from the same
  // definitions, but it is a separate file and a separate language. A label
  // renamed in one and not the other is a button that says one thing and opens
  // another, so the renderer writes a manifest and this compares it.
  const manifest = JSON.parse(
    readFileSync(new URL("../../../deploy/line/rich-menus/manifest.json", import.meta.url), "utf8")
  ) as {
    size: { width: number; height: number };
    menus: {
      key: RichMenuKey;
      name: string;
      chatBarText: string;
      labels: string[];
      icons: string[];
      size: { width: number; height: number };
      areas: unknown[];
    }[];
  };

  it("was rendered at the size each definition declares", () => {
    const definitions = richMenuDefinitions(LIFF_ID);
    for (const definition of definitions) {
      const rendered = manifest.menus.find((menu) => menu.key === definition.key);
      expect(rendered?.size, definition.key).toEqual(definition.size);
    }
  });

  // The renderer runs with a placeholder LIFF id (it only draws labels), so the
  // URIs differ by that id and nothing else. Compare the path, which is the part
  // that decides where a tap goes.
  const normalize = (areas: { bounds: unknown; action: { type: string; uri?: string; text?: string } }[]) =>
    areas.map((area) => ({
      bounds: area.bounds,
      action:
        area.action.type === "uri"
          ? { type: "uri", path: area.action.uri?.replace(/^https:\/\/liff\.line\.me\/[^/]+\//, "") }
          : { type: "message", text: area.action.text }
    }));

  it("has one image per menu, with the same labels and areas", () => {
    const definitions = richMenuDefinitions(LIFF_ID);
    expect(manifest.menus.map((menu) => menu.key)).toEqual(definitions.map((definition) => definition.key));
    for (const definition of definitions) {
      const rendered = manifest.menus.find((menu) => menu.key === definition.key);
      expect(rendered, definition.key).toBeDefined();
      expect(rendered?.labels).toEqual(definition.labels);
      expect(rendered?.icons).toEqual(definition.icons);
      expect(normalize(rendered?.areas as never)).toEqual(normalize(definition.areas as never));
      expect(rendered?.chatBarText).toBe(definition.chatBarText);
    }
  });
});
