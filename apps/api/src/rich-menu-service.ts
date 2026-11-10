/**
 * The parts of the rich menu feature that touch the world: the LINE client, the
 * PNGs on disk, and the users in the database.
 *
 * `rich-menu.ts` stays pure so the definitions and the sync order can be tested
 * without a network; this file is the thin layer that supplies the real client.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { messagingApi } from "@line/bot-sdk";
import { db } from "./db";
import { liffIdentity } from "./schema";
import { resolveUserPrincipal } from "./access-store";
import {
  linkMenuForUser,
  syncRichMenus,
  type RichMenuApi,
  type RichMenuKey,
  type SyncResult
} from "./rich-menu";
import { saveMenuIds } from "./rich-menu-store";

const KEYS: RichMenuKey[] = ["owner", "manager", "technician", "default"];

/**
 * Where the rendered PNGs are. The image bakes them in at `/app/rich-menus`; a
 * local run falls back to the repository copy.
 */
export function richMenuDir(): string {
  const configured = process.env.RICH_MENU_DIR;
  if (configured) return configured;
  if (existsSync("/app/rich-menus")) return "/app/rich-menus";
  return join(process.cwd(), "deploy/line/rich-menus");
}

export function loadMenuImages(dir: string = richMenuDir()): Record<RichMenuKey, Buffer> {
  const images = {} as Record<RichMenuKey, Buffer>;
  for (const key of KEYS) {
    const path = join(dir, `${key}.png`);
    if (!existsSync(path)) {
      throw new Error(`rich menu image missing: ${path} (run deploy/line/render-rich-menus.py)`);
    }
    images[key] = readFileSync(path);
  }
  return images;
}

/** The LINE client, narrowed to what the sync uses. */
export function createRichMenuApi(channelAccessToken: string): RichMenuApi {
  const client = new messagingApi.MessagingApiClient({ channelAccessToken });
  const blob = new messagingApi.MessagingApiBlobClient({ channelAccessToken });
  return {
    createRichMenu: (body) => client.createRichMenu(body as messagingApi.RichMenuRequest),
    // The SDK's blob client takes a Blob and sends its type as the content type;
    // a Buffer alone would go out as application/octet-stream and LINE rejects it.
    setRichMenuImage: (richMenuId, image) =>
      blob.setRichMenuImage(
        richMenuId,
        // `new Uint8Array(image)` rather than the Buffer: a Buffer's backing store
        // is typed ArrayBufferLike, which BlobPart rejects.
        new Blob([new Uint8Array(image)], { type: "image/png" })
      ),
    setDefaultRichMenu: (richMenuId) => client.setDefaultRichMenu(richMenuId),
    linkRichMenuIdToUser: (userId, richMenuId) => client.linkRichMenuIdToUser(userId, richMenuId),
    getRichMenuList: async () => {
      const response = await client.getRichMenuList();
      return {
        richmenus: (response.richmenus ?? []).map((menu) => ({
          richMenuId: menu.richMenuId,
          name: menu.name
        }))
      };
    },
    deleteRichMenu: (richMenuId) => client.deleteRichMenu(richMenuId)
  };
}

export type SyncAndLinkResult = SyncResult & {
  linked: { lineUserId: string; key: RichMenuKey }[];
  failed: { lineUserId: string; error: string }[];
};

/**
 * Create the menus, then point every known LINE user at the one for their role.
 *
 * A user whose link fails is reported rather than thrown: one bad id must not
 * leave the rest of the shop on the old panel.
 */
export async function syncAndLinkUsers(
  api: RichMenuApi,
  input: { liffId: string; dir?: string }
): Promise<SyncAndLinkResult> {
  const result = await syncRichMenus(api, {
    liffId: input.liffId,
    images: loadMenuImages(input.dir)
  });
  saveMenuIds(result.ids);

  const identities = db.select().from(liffIdentity).all();
  const linked: SyncAndLinkResult["linked"] = [];
  const failed: SyncAndLinkResult["failed"] = [];

  for (const identity of identities) {
    try {
      const principal = resolveUserPrincipal(
        { id: identity.userId, name: identity.displayName, email: "" },
        "liff"
      );
      const roles = [...new Set(principal.grants.map((grant) => grant.role))];
      const key = await linkMenuForUser(api, identity.lineUserId, roles, result.ids);
      linked.push({ lineUserId: identity.lineUserId, key });
    } catch (error) {
      failed.push({
        lineUserId: identity.lineUserId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  return { ...result, linked, failed };
}
