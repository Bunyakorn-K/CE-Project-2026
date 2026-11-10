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

export const RICH_MENU_IMAGE = { width: 2500, height: 843 } as const;

/** Every menu this deployment owns starts with this, so stale ones are findable. */
export const RICH_MENU_PREFIX = "laundrytwin:";

export type RichMenuKey = Role | "default";

export type Bounds = { x: number; y: number; width: number; height: number };

export type RichMenuAction =
  | { type: "uri"; uri: string }
  | { type: "message"; text: string };

export type RichMenuArea = { bounds: Bounds; action: RichMenuAction };

export type RichMenuDefinition = {
  key: RichMenuKey;
  /** LINE-side name. Versioned: a menu object cannot be edited, only replaced. */
  name: string;
  /** The bar label, ≤ 14 characters (LINE rejects longer). */
  chatBarText: string;
  /** What the renderer draws in each column, in the same order as `areas`. */
  labels: string[];
  /** Accent colour for the renderer, so the panel matches the role. */
  accent: string;
  areas: RichMenuArea[];
};

/** Equal columns across the image, which is how the renderer draws them. */
export function columnBounds(index: number, count: number): Bounds {
  if (count <= 0) throw new Error("a rich menu needs at least one area");
  if (index < 0 || index >= count) throw new Error(`area ${index} is outside 0..${count - 1}`);
  const width = Math.floor(RICH_MENU_IMAGE.width / count);
  const x = index * width;
  // The last column takes the remainder so the areas cover the image exactly.
  const isLast = index === count - 1;
  return {
    x,
    y: 0,
    width: isLast ? RICH_MENU_IMAGE.width - x : width,
    height: RICH_MENU_IMAGE.height
  };
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
  items: { label: string; path?: string; message?: string }[];
};

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
    accent: "#1f6feb",
    items: [
      { label: "ภาพรวม", path: "/dashboard" },
      { label: "วิเคราะห์", path: "/analytics" },
      { label: "เครื่องซักผ้า", path: "/machines" },
      { label: "ผู้ดูแล", path: "/admin" }
    ]
  },
  {
    key: "manager",
    chatBarText: "เมนูผู้จัดการ",
    accent: "#2ea043",
    items: [
      { label: "ภาพรวม", path: "/dashboard" },
      { label: "วิเคราะห์", path: "/analytics" },
      { label: "เครื่องซักผ้า", path: "/machines" }
    ]
  },
  {
    key: "technician",
    chatBarText: "เมนูช่าง",
    accent: "#d29922",
    items: [
      { label: "ภาพรวม", path: "/dashboard" },
      { label: "เครื่องซักผ้า", path: "/machines" },
      // A message action, not a page: the technician's next step when a machine
      // misbehaves is to tell someone, and a message the user sends is answered
      // with a free reply.
      { label: "แจ้งซ่อม", message: "แจ้งซ่อม" }
    ]
  },
  {
    key: "default",
    chatBarText: "LaundryTwin",
    accent: "#6e7781",
    items: [{ label: "ขอสิทธิ์ใช้งาน", message: "ขอสิทธิ์ใช้งาน" }]
  }
];

function buildDefinition(spec: MenuSpec, liffId: string): RichMenuDefinition {
  const count = spec.items.length;
  return {
    key: spec.key,
    name: `${RICH_MENU_PREFIX}${spec.key}:v1`,
    chatBarText: spec.chatBarText,
    labels: spec.items.map((item) => item.label),
    accent: spec.accent,
    areas: spec.items.map((item, index) => ({
      bounds: columnBounds(index, count),
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
    size: { width: RICH_MENU_IMAGE.width, height: RICH_MENU_IMAGE.height },
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
