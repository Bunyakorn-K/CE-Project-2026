/**
 * Role-based LINE rich menus.
 *
 * A rich menu is the panel above the keyboard. LINE lets a bot have many of them
 * and link a different one to each user, which is the only way to make the panel
 * match what that person can actually do: an owner has a backoffice, a technician
 * does not, and a panel offering a page that answers 403 is worse than a smaller
 * panel.
 *
 * Three facts shape this file:
 *
 * 1. **Rich menus cost nothing.** They are not messages, so they do not touch the
 *    300-a-month push allowance that the alerts are budgeted against. Linking is
 *    free and can be done on every login.
 * 2. **LINE has no update.** A menu object is immutable: changing a label means
 *    creating a new menu, uploading its image, re-pointing the default and every
 *    linked user, then deleting the old one. So the sync is create-then-delete,
 *    and the names carry a version so a half-finished run is recognisable.
 * 3. **The image and the areas are separate.** The picture is drawn by
 *    `deploy/line/render-rich-menus.py`; the tap targets are defined here. They
 *    can drift, so the renderer writes a manifest and a test compares it with
 *    these definitions.
 */

import type { Role } from "./access-policy";

export type RichMenuSize = { width: number; height: number };

/**
 * LINE accepts two shapes. `wide` is one row of tiles above the keyboard; `tall`
 * is a proper panel that covers more of the chat, which is what a menu with a
 * hero tile needs — six tiles in one row makes each one too narrow to read.
 */
export const RICH_MENU_SIZES: Record<"wide" | "tall", RichMenuSize> = {
  wide: { width: 2500, height: 843 },
  tall: { width: 2500, height: 1686 }
};

/** Kept for the tests and the renderer's default; `tall` is opt-in per menu. */
export const RICH_MENU_IMAGE = RICH_MENU_SIZES.wide;

/**
 * How the areas are arranged.
 *
 * `row` is N equal columns. `hero` is one tile across the full width with the rest
 * in a row beneath it — the shape that keeps a five- or six-item menu readable
 * instead of squeezing every label into a 400px column.
 */
export type RichMenuLayout = "row" | "hero";

/** Every menu this deployment owns starts with this, so stale ones are findable. */
export const RICH_MENU_PREFIX = "laundrytwin:";

export type RichMenuKey = Role | "default";

export type Bounds = { x: number; y: number; width: number; height: number };

export type RichMenuAction =
  | { type: "uri"; uri: string }
  | { type: "message"; text: string };

export type RichMenuArea = { bounds: Bounds; action: RichMenuAction };

/** Icon names the renderer knows how to draw. Kept as strings so this file stays
 *  platform-free and the picture is a rendering concern. */
export type RichMenuIcon = "grid" | "chart" | "washer" | "shield" | "wrench" | "chat" | "key";

export type RichMenuDefinition = {
  key: RichMenuKey;
  /** LINE-side name. Versioned: a menu object cannot be edited, only replaced. */
  name: string;
  /** The bar label, ≤ 14 characters (LINE rejects longer). */
  chatBarText: string;
  /** What the renderer draws in each column, in the same order as `areas`. */
  labels: string[];
  /** One icon and one tile colour per column, same order as `areas`. */
  icons: RichMenuIcon[];
  colors: string[];
  /** Accent colour for the renderer, so the panel matches the role. */
  accent: string;
  size: RichMenuSize;
  layout: RichMenuLayout;
  areas: RichMenuArea[];
};

/** How much of a tall panel the hero tile takes. The rest is the row beneath. */
export const HERO_HEIGHT_RATIO = 0.4;

function assertIndex(index: number, count: number) {
  if (count <= 0) throw new Error("a rich menu needs at least one area");
  if (index < 0 || index >= count) throw new Error(`area ${index} is outside 0..${count - 1}`);
}

/** Equal columns across the whole image. */
export function rowBounds(index: number, count: number, size: RichMenuSize = RICH_MENU_IMAGE): Bounds {
  assertIndex(index, count);
  const width = Math.floor(size.width / count);
  const x = index * width;
  // The last column takes the remainder so the areas cover the image exactly.
  const isLast = index === count - 1;
  return {
    x,
    y: 0,
    width: isLast ? size.width - x : width,
    height: size.height
  };
}

/**
 * A full-width tile on top, the remaining areas in one row beneath it.
 *
 * Bounds tile the whole image: the hero spans the width, the row below splits the
 * remainder, and the last tile takes the leftover pixels so nothing is uncovered —
 * an uncovered strip shows the canvas colour through the panel.
 */
export function heroBounds(index: number, count: number, size: RichMenuSize = RICH_MENU_SIZES.tall): Bounds {
  assertIndex(index, count);
  if (count < 2) throw new Error("a hero layout needs a tile beneath it");
  const heroHeight = Math.round(size.height * HERO_HEIGHT_RATIO);
  if (index === 0) {
    return { x: 0, y: 0, width: size.width, height: heroHeight };
  }
  const columns = count - 1;
  const column = Math.floor(size.width / columns);
  const position = index - 1;
  const x = position * column;
  const isLast = position === columns - 1;
  return {
    x,
    y: heroHeight,
    width: isLast ? size.width - x : column,
    height: size.height - heroHeight
  };
}

export function layoutBounds(
  index: number,
  count: number,
  size: RichMenuSize,
  layout: RichMenuLayout
): Bounds {
  return layout === "hero" ? heroBounds(index, count, size) : rowBounds(index, count, size);
}

/** @deprecated name kept for the existing call sites; equal columns, wide size. */
export function columnBounds(index: number, count: number): Bounds {
  return rowBounds(index, count, RICH_MENU_IMAGE);
}

/** `https://liff.line.me/<id>/<path>` — the path is forwarded to the LIFF endpoint. */
export function liffUri(liffId: string, path: string): string {
  const clean = path.startsWith("/") ? path.slice(1) : path;
  return `https://liff.line.me/${liffId}/${clean}`;
}

type MenuSpec = {
  key: RichMenuKey;
  chatBarText: string;
  accent: string;
  /** Defaults to the wide single-row panel. */
  layout?: RichMenuLayout;
  items: { label: string; icon: RichMenuIcon; color: string; path?: string; message?: string }[];
};

// A tile palette rather than one accent per role: the panel is a grid of buttons,
// and four identical squares of the same blue is harder to aim at than four
// distinguishable tiles. The reference the owner pointed at does the same.
const BLUE = "#1f6feb";
const GREEN = "#2ea043";
const ORANGE = "#d29922";
const PURPLE = "#8250df";
const TEAL = "#1b7c83";
const SLATE = "#57606a";

/**
 * The chat tile.
 *
 * It is a `message` action, not a link: tapping it sends a line of text as the
 * user, which opens the conversation and is answered with a free reply. That is
 * the difference between "the panel has a button to the web app" and "the panel
 * can start a conversation with the assistant".
 */
const CHAT = { label: "แชทกับ AI", icon: "chat" as RichMenuIcon, color: PURPLE, message: "สวัสดี" };

/**
 * What each role gets, and why.
 *
 * The app itself gives every role the dashboard, the machines and the analytics
 * (revenue is redacted for technicians, not the page). The differences that
 * matter for a panel are the backoffice — owner only — and what a technician
 * reaches for when something is wrong, which is a person, not a chart.
 */
const SPECS: MenuSpec[] = [
  {
    key: "owner",
    chatBarText: "เมนูเจ้าของ",
    accent: BLUE,
    // Five tiles in one row squeezed every label into a 400px column. The
    // dashboard — what an owner opens most — takes the full-width tile on top and
    // the other four sit beneath it.
    layout: "hero",
    items: [
      { label: "ภาพรวม", icon: "grid", color: BLUE, path: "/dashboard" },
      { label: "วิเคราะห์", icon: "chart", color: GREEN, path: "/analytics" },
      { label: "เครื่องซักผ้า", icon: "washer", color: TEAL, path: "/machines" },
      { label: "ผู้ดูแล", icon: "shield", color: ORANGE, path: "/admin" },
      CHAT
    ]
  },
  {
    key: "manager",
    chatBarText: "เมนูผู้จัดการ",
    accent: GREEN,
    items: [
      { label: "ภาพรวม", icon: "grid", color: BLUE, path: "/dashboard" },
      { label: "วิเคราะห์", icon: "chart", color: GREEN, path: "/analytics" },
      { label: "เครื่องซักผ้า", icon: "washer", color: TEAL, path: "/machines" },
      CHAT
    ]
  },
  {
    key: "technician",
    chatBarText: "เมนูช่าง",
    accent: ORANGE,
    items: [
      { label: "ภาพรวม", icon: "grid", color: BLUE, path: "/dashboard" },
      { label: "เครื่องซักผ้า", icon: "washer", color: TEAL, path: "/machines" },
      // A message action, not a page: the technician's next step when a machine
      // misbehaves is to tell someone, and a message the user sends is answered
      // with a free reply.
      { label: "แจ้งซ่อม", icon: "wrench", color: ORANGE, message: "แจ้งซ่อม" },
      CHAT
    ]
  },
  {
    key: "default",
    chatBarText: "LaundryTwin",
    accent: SLATE,
    items: [
      { label: "ขอสิทธิ์ใช้งาน", icon: "key", color: SLATE, message: "ขอสิทธิ์ใช้งาน" },
      CHAT
    ]
  }
];

function buildDefinition(spec: MenuSpec, liffId: string): RichMenuDefinition {
  const count = spec.items.length;
  const layout: RichMenuLayout = spec.layout ?? "row";
  return {
    key: spec.key,
    // v3: the owner panel grew a hero tile, so its shape changed. The version is in
    // the name because LINE cannot edit a menu — two versions side by side in the
    // list is how a half-finished sync is recognisable.
    name: `${RICH_MENU_PREFIX}${spec.key}:v3`,
    chatBarText: spec.chatBarText,
    labels: spec.items.map((item) => item.label),
    icons: spec.items.map((item) => item.icon),
    colors: spec.items.map((item) => item.color),
    accent: spec.accent,
    size: layout === "hero" ? RICH_MENU_SIZES.tall : RICH_MENU_SIZES.wide,
    layout,
    areas: spec.items.map((item, index) => ({
      bounds: layoutBounds(index, count, layout === "hero" ? RICH_MENU_SIZES.tall : RICH_MENU_SIZES.wide, layout),
      action: item.path
        ? { type: "uri", uri: liffUri(liffId, item.path) }
        : { type: "message", text: item.message ?? item.label }
    }))
  };
}

/** All four menus, with URIs resolved against the deployment's LIFF id. */
export function richMenuDefinitions(liffId: string): RichMenuDefinition[] {
  return SPECS.map((spec) => buildDefinition(spec, liffId));
}

/**
 * Which menu a user gets. The strongest grant wins: someone who is an owner in
 * one branch and a technician in another is an owner, because the panel must not
 * hide a page they are allowed to open.
 */
export function menuKeyForRoles(roles: Role[]): RichMenuKey {
  if (roles.includes("owner")) return "owner";
  if (roles.includes("manager")) return "manager";
  if (roles.includes("technician")) return "technician";
  return "default";
}

/** The object LINE's `POST /v2/bot/richmenu` expects. */
export function buildRichMenuObject(definition: RichMenuDefinition) {
  return {
    size: { width: definition.size.width, height: definition.size.height },
    selected: true,
    name: definition.name,
    chatBarText: definition.chatBarText,
    areas: definition.areas.map((area) => ({
      bounds: area.bounds,
      action: area.action
    }))
  };
}

/**
 * The slice of the LINE client this module needs, so tests can pass a fake and
 * the sync can be exercised without a network.
 */
export type RichMenuApi = {
  createRichMenu: (body: unknown) => Promise<{ richMenuId: string }>;
  /** The SDK takes a Blob and derives the content type from it. */
  setRichMenuImage: (richMenuId: string, image: Buffer) => Promise<unknown>;
  setDefaultRichMenu: (richMenuId: string) => Promise<unknown>;
  linkRichMenuIdToUser: (userId: string, richMenuId: string) => Promise<unknown>;
  getRichMenuList: () => Promise<{ richmenus: { richMenuId: string; name: string }[] }>;
  deleteRichMenu: (richMenuId: string) => Promise<unknown>;
};

export type SyncResult = {
  /** key -> the rich menu id LINE assigned. */
  ids: Record<RichMenuKey, string>;
  created: string[];
  deleted: string[];
  defaultId: string;
};

/**
 * Create every menu, upload its image, make `default` the fallback, and delete
 * the menus this deployment owned before.
 *
 * Order matters: the new menus exist and are complete before anything is deleted,
 * so a failure halfway leaves the old panel working rather than nobody's.
 */
export async function syncRichMenus(
  api: RichMenuApi,
  input: { liffId: string; images: Record<RichMenuKey, Buffer> }
): Promise<SyncResult> {
  const definitions = richMenuDefinitions(input.liffId);
  const existing = await api.getRichMenuList();
  const previous = existing.richmenus.filter((menu) => menu.name.startsWith(RICH_MENU_PREFIX));

  const ids = {} as Record<RichMenuKey, string>;
  const created: string[] = [];

  for (const definition of definitions) {
    const image = input.images[definition.key];
    if (!image || image.length === 0) {
      throw new Error(`no image for the ${definition.key} menu`);
    }
    const { richMenuId } = await api.createRichMenu(buildRichMenuObject(definition));
    await api.setRichMenuImage(richMenuId, image);
    ids[definition.key] = richMenuId;
    created.push(richMenuId);
  }

  await api.setDefaultRichMenu(ids.default);

  const current = new Set(Object.values(ids));
  const deleted: string[] = [];
  for (const menu of previous) {
    if (current.has(menu.richMenuId)) continue;
    await api.deleteRichMenu(menu.richMenuId);
    deleted.push(menu.richMenuId);
  }

  return { ids, created, deleted, defaultId: ids.default };
}

/**
 * Point one user at the menu for their role.
 *
 * Called on every LIFF login: it is a single free API call, and doing it there
 * means a role change takes effect the next time the person opens the app rather
 * than waiting for someone to remember a bulk sync.
 */
export async function linkMenuForUser(
  api: Pick<RichMenuApi, "linkRichMenuIdToUser">,
  userId: string,
  roles: Role[],
  ids: Record<RichMenuKey, string>
): Promise<RichMenuKey> {
  const key = menuKeyForRoles(roles);
  await api.linkRichMenuIdToUser(userId, ids[key]);
  return key;
}
