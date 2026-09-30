import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Deployment-configuration guards.
//
// `deploy/tofu` renders each .env file over the live one with `install -m 0600`,
// so a key missing from locals.tf is a key DELETED by the next `tofu apply`.
// That is not hypothetical: applying this configuration as it stood on
// 2026-09-29 would have deleted the four *_IMAGE keys (so compose fell back to
// resolving bare `laundrytwin-*:latest` on Docker Hub and `docker compose pull`
// failed) and LINE_LOGIN_CHANNEL_IDS (so LINE Login rejected every token).
//
// Every assertion here is derived from the files on disk - the compose
// interpolation set, the service sources' own `process.env` reads, the
// `sensitive = true` variable set - so the guards keep working when the
// deployment changes. The few hand-written allowlists carry a reason for each
// entry and are deliberately small.
//
// These tests read deploy/ only. They do not run tofu, touch a host, or need
// any credential.

const root = fileURLToPath(new URL("../../../", import.meta.url));
const read = (relative: string): string => readFileSync(`${root}${relative}`, "utf8");

const locals = read("deploy/tofu/locals.tf");
const variables = read("deploy/tofu/variables.tf");
const envfiles = read("deploy/tofu/envfiles.tf");
const stacks = read("deploy/tofu/stacks.tf");
const tfvarsExample = read("deploy/tofu/terraform.tfvars.example");
const appCompose = read("compose.yaml");
const analyticsCompose = read("deploy/analytics/compose.yaml");
const registryConfig = read("deploy/registry/config.yml");

/** Env templates in locals.tf: name -> template body. */
function envTemplates(source: string): Map<string, string> {
  const templates = new Map<string, string>();
  const pattern = /^\s{2}(\w+)\s*=\s*trimspace\(<<-EOT\n([\s\S]*?)\n\s*EOT\s*\n\s*\)/gm;
  for (const match of source.matchAll(pattern)) {
    templates.set(match[1]!, match[2]!);
  }
  return templates;
}

/** KEY names assigned in an env template body, in order. */
function envKeys(body: string): string[] {
  return [...body.matchAll(/^\s*([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]!);
}

/** Variable blocks in variables.tf: name -> whether it is marked sensitive. */
function declaredVariables(source: string): Map<string, boolean> {
  const declared = new Map<string, boolean>();
  for (const match of source.matchAll(/variable\s+"(\w+)"\s*\{([\s\S]*?)\n\}/g)) {
    declared.set(match[1]!, /sensitive\s*=\s*true/.test(match[2]!));
  }
  return declared;
}

/** `${VAR}` references in a compose file, ignoring `${VAR:-default}`. */
function composeEnvRefs(source: string): Set<string> {
  return new Set([...source.matchAll(/\$\{([A-Z][A-Z0-9_]*)(?:[:-][^}]*)?\}/g)].map((match) => match[1]!));
}

/** Full-line `#` comments, dropped so a note *about* a removed key is allowed. */
function withoutCommentLines(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function walk(dir: string, extension: string): string[] {
  return readdirSync(dir)
    .flatMap((entry) => {
      const path = `${dir}/${entry}`;
      if (statSync(path).isDirectory()) return walk(path, extension);
      return path.endsWith(extension) && !path.includes(".test.") ? [path] : [];
    })
    .sort();
}

/** UPPER_SNAKE keys a source tree reads off the environment. */
function envReadsIn(dir: string): Set<string> {
  const reads = new Set<string>();
  for (const file of walk(dir, ".ts")) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)) reads.add(match[1]!);
  }
  return reads;
}

// The ETL package holds two entry points: the batch loop (src/index.ts and its
// imports) and the weather collector (src/weather-run.ts and its imports).
// Splitting by file keeps the weather collector from inheriting the batch
// loop's PG_CONNECTION_STRING - that inheritance is the defect being guarded.
const etlBatchReads = envReadsIn(`${root}apps/etl/src`).has("PG_CONNECTION_STRING")
  ? envReadsIn(`${root}apps/etl/src`)
  : new Set<string>();
const weatherReads = new Set(
  [...readFileSync(`${root}apps/etl/src/weather-run.ts`, "utf8").matchAll(/process\.env\.([A-Z][A-Z0-9_]*)/g)].map(
    (match) => match[1]!
  )
);
// requireEnv(name) in weather-run.ts looks TMD_API_KEY up by string, so the
// static scan cannot see it. Declared here rather than scanned.
weatherReads.add("TMD_API_KEY");

const apiReads = envReadsIn(`${root}apps/api/src`);
// better-auth reads these itself; no repo source references them.
apiReads.add("BETTER_AUTH_SECRET");

const templates = envTemplates(locals);
const sensitiveVars = new Set(
  [...declaredVariables(variables)].filter(([, sensitive]) => sensitive).map(([name]) => name)
);
const allTemplates = [...templates.values()].join("\n");

/** Keys in an env template whose value comes from a `sensitive = true` variable. */
function secretKeysIn(body: string): string[] {
  return envKeys(body).filter((key) => {
    const line = body.split("\n").find((candidate) => candidate.trim().startsWith(`${key}=`)) ?? "";
    return [...line.matchAll(/\$\{var\.(\w+)\}/g)].some((match) => sensitiveVars.has(match[1]!));
  });
}

describe("tofu env contract", () => {
  it("renders every env file it installs", () => {
    expect([...templates.keys()].sort()).toEqual([
      "analytics_env",
      "app_env",
      "etl_env",
      "gas_env",
      "weather_env"
    ]);
  });

  it("installs every env file it renders", () => {
    // A template rendered to rendered/ but never `install`ed leaves the
    // container on the previous file, so the keys are delivered and then
    // silently ignored - the same failure shape as the image tags.
    const declared = [...envfiles.matchAll(/filename\s+=\s+"[^"]*rendered\/([\w.-]+)"/g)].map((match) => match[1]!);
    const installed = new Set([...envfiles.matchAll(/install[^\n]*?rendered\/([\w.-]+)/g)].map((match) => match[1]!));

    expect(declared.filter((stem) => !installed.has(stem))).toEqual([]);
    expect(declared.length).toBe(6);
  });

  it("delivers every variable the compose stacks interpolate", () => {
    // This is the check that would have caught the *_IMAGE and
    // CLICKHOUSE_READER_PASSWORD omissions. compose expands ${VAR} from the env
    // file tofu overwrites; a ref with no matching key resolves to the literal
    // string "${VAR}" and breaks the stack.
    const refs = [...new Set([...composeEnvRefs(appCompose), ...composeEnvRefs(analyticsCompose)])];
    const produced = new Set([...templates.values()].flatMap(envKeys));

    expect(refs.filter((ref) => !produced.has(ref))).toEqual([]);
  });

  it("re-installs the env files when a template changes", () => {
    // `install_envs` re-ran only when a directory or the repo ref changed, so
    // editing a template rewrote rendered/*.env and nothing delivered it - while
    // the stack resource, which hashes the same values, DID re-run and recreated
    // the containers. The apply looked successful and the containers read the
    // previous file.
    const block = envfiles.match(/resource "null_resource" "install_envs" \{([\s\S]*?)\n  provisioner/)![1];

    expect(block).toMatch(/env_hash\s*=\s*sha256\(/);
    for (const template of ["app_env", "etl_env", "weather_env", "gas_env", "analytics_env"]) {
      expect(block).toContain(`local.${template}`);
    }
  });

  it("delivers the keys whose absence breaks a running service", () => {
    const produced = new Set([...templates.values()].flatMap(envKeys));

    // apps/api/src/liff-auth.ts verifies the LIFF ID token against these.
    // Without them the server rejects every LINE Login token - not a degraded
    // feature, a total login outage.
    expect(produced.has("LINE_LOGIN_CHANNEL_IDS")).toBe(true);
    // apps/etl/src/weather-run.ts requireEnv() throws without it, so the
    // hourly TMD collector exits non-zero.
    expect(produced.has("TMD_API_KEY")).toBe(true);
    // apps/etl/src/gas-run.ts requireEnv() throws without it, so the hourly gas
    // collector exits non-zero and retries into the same 401 forever.
    expect(produced.has("HA_TOKEN")).toBe(true);
    // All five app images; without them compose resolves bare
    // `laundrytwin-*:latest` against Docker Hub and the pull fails.
    for (const key of ["API_IMAGE", "WEB_IMAGE", "ETL_IMAGE", "WEATHER_IMAGE", "GAS_IMAGE"]) {
      expect(produced.has(key)).toBe(true);
    }
  });

  it("installs each env file where its compose service looks for it", () => {
    // weather.env is the whole point of the split: the collector must stop
    // reading the ETL env file, which carries PG_CONNECTION_STRING.
    expect(appCompose).not.toMatch(/^\s*-\s+\$\{WEATHER_IMAGE[^}]*\}[^\n]*\n(?:.*\n)*?\s*env_file:\s*\$\{ETL_ENV_FILE/m);
    expect(appCompose).toMatch(/WEATHER_ENV_FILE/);
    expect(envfiles).toMatch(/\$\{local\.app_dir\}\/weather\.env/);
    // gas.env follows the same split: the collector reads Home Assistant and
    // ClickHouse, never IRIS Postgres, and must not inherit the ETL env.
    expect(appCompose).toMatch(/GAS_ENV_FILE/);
    expect(envfiles).toMatch(/\$\{local\.app_dir\}\/gas\.env/);
  });

  it("keeps the gas collector out of a default `compose up`", () => {
    // The gas image is not built and Home Assistant has no token provisioned.
    // Without a profile, the next `docker compose up -d` on VM 117 tries to
    // start it and fails on a missing image or a 401 - a self-inflicted
    // outage in a stack that is otherwise healthy. Enabling it is deliberate.
    expect(appCompose).toMatch(/profiles:\s*\[\"gas\"\]/);
  });

  it("renders the gas collector's ClickHouse credential as the writer, not the reader", () => {
    // The collector INSERTs into fact_gas_pressure_sample. The reader
    // credential that app_env carries is read-only, so a copy-paste of the
    // app template here would fail at the first write with a permissions
    // error that looks like a schema problem.
    const line = templates
      .get("gas_env")!
      .split("\n")
      .find((l) => l.trim().startsWith("CLICKHOUSE_PASSWORD="));
    expect(line).toContain("var.clickhouse_password");
    expect(line).not.toContain("var.clickhouse_reader_password");
  });

  it("gives the gas collector no IRIS Postgres connection string", () => {
    // Same reason as weather.env: sharing the ETL env handed the collector a
    // PG_CONNECTION_STRING it cannot use.
    expect(templates.get("gas_env")).not.toContain("PG_CONNECTION_STRING");
  });

  it("resolves the analytics CLICKHOUSE_PASSWORD to the admin credential", () => {
    // clickhouse-admin-networks.xml is the only definition of `admin` and reads
    // <password from_env="CLICKHOUSE_PASSWORD"/>. Rendering the reader secret
    // into this slot repoints the admin login on the next restart and breaks
    // every ETL write.
    const line = templates.get("analytics_env")!.split("\n").find((l) => l.trim().startsWith("CLICKHOUSE_PASSWORD="));
    expect(line).toBeDefined();
    expect(line).toContain("var.clickhouse_password");
    expect(line).not.toContain("var.clickhouse_reader_password");
  });

  it("does not reintroduce the stale secrets no code path reads", () => {
    // ANALYTICS_READ_API_KEY and OPENROUTER_API_KEY survived a rename. No
    // source in apps/ reads either. The first tofu apply has not run yet, so
    // ANALYTICS_READ_API_KEY is still a key on the live /opt/analytics/.env
    // (checked 2026-09-30 by key name) and the apply is what will delete it.
    // Comment lines are stripped so the removal stays documented, but a live
    // assignment - in a heredoc or a variable block - fails here.
    const corpus = [locals, variables, tfvarsExample, appCompose, analyticsCompose]
      .map(withoutCommentLines)
      .join("\n");
    for (const dead of ["ANALYTICS_READ_API_KEY", "OPENROUTER_API_KEY"]) {
      expect(corpus).not.toContain(dead);
      expect(corpus).not.toContain(dead.toLowerCase());
    }
  });

  it("declares every variable it references, and references every variable it declares", () => {
    const sources = ["locals.tf", "envfiles.tf", "stacks.tf", "checkout.tf", "outputs.tf"]
      .map((file) => read(`deploy/tofu/${file}`))
      .join("\n");
    const referenced = new Set([...sources.matchAll(/var\.(\w+)/g)].map((match) => match[1]!));
    const declared = new Set(declaredVariables(variables).keys());

    // A typo in a var name is a plan-time error at best; an unused declaration
    // is a secret the operator thinks is being delivered.
    expect([...referenced].filter((name) => !declared.has(name)).sort()).toEqual([]);
    expect([...declared].filter((name) => !referenced.has(name)).sort()).toEqual([]);
  });
});

describe("secrets are per-service", () => {
  const surfaces: Array<{ service: string; env: string; reads: Set<string> }> = [
    { service: "api", env: "app_env", reads: apiReads },
    { service: "etl", env: "etl_env", reads: etlBatchReads },
    { service: "weather", env: "weather_env", reads: weatherReads },
    { service: "analytics", env: "analytics_env", reads: new Set(composeEnvRefs(analyticsCompose)) }
  ];

  it.each(surfaces)("$service receives no secret its own code cannot read", ({ env, reads }) => {
    const body = templates.get(env);
    expect(body).toBeDefined();
    expect(secretKeysIn(body!).filter((key) => !reads.has(key))).toEqual([]);
  });

  it("keeps the IRIS connection string out of the weather collector", () => {
    // The concrete failure this guard exists for: weather used to load the ETL
    // env file, so it held PG_CONNECTION_STRING and could read IRIS Postgres.
    const weather = templates.get("weather_env")!;
    expect(envKeys(weather)).not.toContain("PG_CONNECTION_STRING");
    expect(weatherReads.has("PG_CONNECTION_STRING")).toBe(false);
    expect(envKeys(templates.get("etl_env")!)).toContain("PG_CONNECTION_STRING");
  });

  it("keeps the write-capable ClickHouse credential out of the API", () => {
    // The API gets CLICKHOUSE_USER=reader plus the reader password; the admin
    // password is the ETL/weather write path and must never reach a service
    // that only reads.
    const app = templates.get("app_env")!;
    expect(app).toContain("CLICKHOUSE_USER=reader");
    const password = app.split("\n").find((l) => l.trim().startsWith("CLICKHOUSE_PASSWORD="))!;
    expect(password).toContain("var.clickhouse_reader_password");
    expect(secretKeysIn(app)).not.toContain("ANALYTICS_READ_API_KEY");
  });

  it("gives the web container no env file at all", () => {
    // web holds nothing: VITE_* values are baked at image build time and the
    // browser must never receive an upstream credential.
    const webBlock = appCompose.slice(appCompose.indexOf("  web:"), appCompose.indexOf("  etl:"));
    expect(webBlock).not.toContain("env_file");
    expect(webBlock).not.toContain("environment:");
  });
});

describe("exposed services are authenticated", () => {
  it("requires htpasswd auth on the internal registry", () => {
    // Without this block registry:2 accepts anonymous push AND pull, so
    // anything that can reach :5000 can overwrite the images the deploy path
    // pulls. A hand-edited config.yml removed it on this host once already.
    expect(registryConfig).toMatch(/^auth:\s*$/m);
    expect(registryConfig).toMatch(/htpasswd:/);
    expect(registryConfig).toMatch(/path:\s*\/auth\/htpasswd/);
  });

  it("wires the registry to a credential the operator supplies as a hash", () => {
    // A plaintext password variable would be interpolated into a local-exec
    // command line. A pre-hashed `user:hash` line cannot leak that way.
    const declared = declaredVariables(variables);
    expect(declared.get("registry_htpasswd_entry")).toBe(true);
    expect(tfvarsExample).toMatch(/registry_htpasswd_entry\s*=/);
    expect(envfiles).toMatch(/registry_htpasswd_entry is empty/);
    expect(read("deploy/registry/compose.yaml")).toMatch(/\.\/htpasswd:\/auth\/htpasswd/);
  });

  it("asserts registry auth at smoke time, expecting 401", () => {
    expect(stacks).toMatch(/check registry_auth\s+http:\/\/127\.0\.0\.1:5000\/v2\/\s+401/);
  });

  it("binds the MCP inspector to loopback with its auth check on", () => {
    // The shipped compose is right; the running host drifted to 0.0.0.0 with
    // DANGEROUSLY_OMIT_AUTH=true, which is an unauthenticated MCP proxy on all
    // interfaces. deploy-runbook.md already mandates the values asserted here.
    // HOST/DANGEROUSLY_BIND_ALL_INTERFACES inside the container are fine: the
    // published port is what decides reachability from outside.
    const block = analyticsCompose.slice(
      analyticsCompose.indexOf("  mcp-inspector:"),
      analyticsCompose.indexOf("  redis:")
    );
    expect(block).toMatch(/DANGEROUSLY_OMIT_AUTH:\s*'false'/);
    expect(block).toMatch(/ports:\s*\n\s*-\s*127\.0\.0\.1:6274:6274/);
    expect(block).not.toMatch(/-\s*6274:6274/);
  });

  it("never disables the inspector auth anywhere in the repository", () => {
    for (const file of ["deploy/analytics/compose.yaml", "compose.yaml", "deploy/arcane/compose.yaml"]) {
      expect(read(file)).not.toMatch(/DANGEROUSLY_OMIT_AUTH:\s*'?true'?/);
    }
  });
});

describe("the analytics compose file matches the running host", () => {
  // All three guards below exist because the repo silently drifted from
  // /opt/analytics/compose.yaml on the VM, and nothing in the repository
  // noticed. Each asserts a fact only the live file had.
  const clickhouseBlock = analyticsCompose.slice(
    analyticsCompose.indexOf("  clickhouse:"),
    analyticsCompose.indexOf("  mcp-inspector:")
  );

  it("mounts the committed server RAM cap", () => {
    // An uncapped ClickHouse grew until the kernel OOM killer took the 10 GB
    // host down (2026-09-16) and every proxied app returned 502. The cap is a
    // config.d file, so a compose file that does not mount it runs an uncapped
    // server no matter what the rest of the stack looks like.
    expect(clickhouseBlock).toMatch(
      /\.\/clickhouse-memory\.xml:\/etc\/clickhouse-server\/config\.d\/memory\.xml:ro/
    );
    const cap = read("deploy/analytics/clickhouse-memory.xml");
    expect(cap).toMatch(/<max_server_memory_usage>3221225472<\/max_server_memory_usage>/);
  });

  it("mounts the external restored warehouse volume, not the managed one", () => {
    // The live warehouse is the hand-created external volume
    // analytics_clickhouse-data-restored. Re-attaching the compose-managed
    // clickhouse-data name comes up as an empty warehouse, which reads as total
    // data loss on a warehouse that is in fact intact.
    expect(clickhouseBlock).toMatch(/- clickhouse-data-restored:\/var\/lib\/clickhouse/);
    expect(clickhouseBlock).not.toMatch(/- clickhouse-data:\/var\/lib\/clickhouse/);
    expect(analyticsCompose).toMatch(
      /clickhouse-data-restored:\s*\n\s*external: true\s*\n\s*name: analytics_clickhouse-data-restored/
    );
  });

  it("points Superset at the least-privilege Postgres role, not the Airflow superuser", () => {
    // `airflow` is a Postgres superuser that also owns the Airflow metadata
    // database. Superset only needs DML on its own `superset` database.
    const line = analyticsCompose
      .split("\n")
      .find((l) => l.trim().startsWith("SUPERSET_DATABASE_URI:"))!;
    expect(line).toContain("postgresql+psycopg2://superset_app:${SUPERSET_DB_PASSWORD}@");
    expect(line).not.toContain("://airflow:");
  });
});

describe("the analytics sync cannot lose an unlisted file", () => {
  const excludes = read("deploy/tofu/analytics-rsync.excludes");
  const allowlist = read("deploy/tofu/analytics-delete-allowlist.txt");
  const gate = read("deploy/tofu/scripts/analytics-rsync.sh");

  it("routes the sync through the gate, not a bare --delete", () => {
    // The sync used to be `rsync -a --delete` with three inline excludes and no
    // preview: nothing printed what would be deleted, so "apply only after
    // diffing and seeing nothing is lost" was a habit, not a mechanism.
    expect(stacks).not.toMatch(/rsync -a --delete/);
    expect(stacks).toMatch(/analytics-rsync\.sh/);
    expect(stacks).toMatch(/analytics-delete-allowlist\.txt/);
  });

  it("prints the dry-run diff and refuses an unlisted deletion", () => {
    // Same flags in both passes, so the printed deletions are the real ones; and
    // the refusal exits non-zero, which under `set -e` aborts the apply before
    // the .env install and before `docker compose up -d`.
    expect(gate).toMatch(/--dry-run/);
    expect(gate).toMatch(/-a --delete --itemize-changes/);
    expect(gate).toMatch(/\^\\\*deleting/);
    expect(gate).toMatch(/REFUSED/);
    expect(gate).toMatch(/exit 1/);
  });

  it("protects the paths the operator keeps by hand", () => {
    const patterns = excludes.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    // `*.bak-*` is the pattern the inline excludes were missing: an rsync pattern
    // with no `/` matches trailing path components only and `*` does not cross
    // `/`, so `*.before-*` cannot match compose.yaml.bak-*. Verified with
    // `rsync -ani --delete`, where the old set listed all five .bak- files as
    // `*deleting`.
    expect(patterns).toEqual(expect.arrayContaining([".env", "*.before-*", "*.bak-*", "dags-disabled"]));
    // openrsync silently drops an unterminated final pattern, un-protecting the
    // last entry. The trailing newline is load-bearing.
    expect(excludes.endsWith("\n")).toBe(true);
  });

  it("holds no deletion allowlist entries yet", () => {
    // Nothing in /opt/analytics was enumerated when this was written, so the
    // first real apply must stop at the gate. An entry added without the
    // corresponding evidence is the thing this list exists to prevent.
    const entries = allowlist.split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#"));
    expect(entries).toEqual([]);
  });
});

describe("credentials that already exist outside this repository", () => {
  it("warns that the two pre-existing secrets must be supplied unchanged", () => {
    // Both render cleanly whatever the value is, pass `tofu validate`, and then
    // fail somewhere that reads like a different component: the Pi Caddyfile
    // answers 401 for the public ClickHouse route while the API keeps working,
    // or Superset cannot reach its own metadata DB. Nothing in an apply fails.
    const lines = tfvarsExample.split("\n");
    for (const name of ["clickhouse_reader_password", "superset_db_password"]) {
      const declaration = variables.match(new RegExp(`variable "${name}" \\{([\\s\\S]*?)\\n\\}`))![1];
      expect(declaration).toMatch(/description = <<-EOT/);
      expect(declaration.toLowerCase()).toMatch(/already|existing/);

      // The file an operator actually copies has to carry the same warning,
      // immediately around the assignment they are about to fill in.
      const at = lines.findIndex((l) => l.startsWith(name));
      expect(at).toBeGreaterThan(0);
      const nearby = lines.slice(Math.max(0, at - 4), at + 8).join("\n");
      expect(nearby).toContain(name);
      expect(nearby).toMatch(/must be|already/i);
    }
  });
});

describe("no secret in a committed or hand-created file", () => {
  it("resolves every committed ClickHouse password from the environment", () => {
    // clickhouse-reader.xml uses <password from_env=.../>. The host instead
    // carries a hand-written clickhouse-reader.local.xml with a literal
    // password, which no audit or secret scan can see.
    for (const file of walk(`${root}deploy/analytics`, ".xml")) {
      for (const match of readFileSync(file, "utf8").matchAll(/<password[^>]*>/g)) {
        expect(match[0]).toContain("from_env=");
      }
    }
  });

  it("carries no hand-created .local.xml override", () => {
    expect(walk(`${root}deploy`, ".xml").filter((file) => file.includes(".local."))).toEqual([]);
  });

  it("keeps rendered credentials and tfvars out of git", () => {
    const ignored = read("deploy/tofu/.gitignore");
    for (const pattern of ["rendered/", "*.tfvars", "terraform.tfstate", "tofu.tfstate"]) {
      expect(ignored).toContain(pattern);
    }
  });
});
