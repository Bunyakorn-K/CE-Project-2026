import { config } from "dotenv";
import { fileURLToPath } from "node:url";

export const projectRoot = fileURLToPath(new URL("../../../", import.meta.url));

config({ path: fileURLToPath(new URL("../../../.env", import.meta.url)), quiet: true });
