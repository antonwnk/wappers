import { readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { z } from "zod";

const SessionConfigSchema = z.object({
  id: z
    .string()
    .min(1)
    .regex(/^[a-z0-9_-]+$/i, "session id must be alphanumeric / dashes / underscores"),
  webhookUrl: z.url(),
  webhookSecret: z.string().min(8, "webhookSecret must be at least 8 chars"),
});

const HttpConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).default(3000),
  bearerToken: z.string().min(8).optional(),
});

export const ConfigSchema = z.object({
  dataDir: z.string().min(1).default("./data"),
  http: HttpConfigSchema.default({ port: 3000 }),
  sessions: z.array(SessionConfigSchema).min(1, "at least one session is required"),
})
  .superRefine((cfg, ctx) => {
    const ids = new Set<string>();
    for (const s of cfg.sessions) {
      if (ids.has(s.id)) {
        ctx.addIssue({ code: "custom", path: ["sessions"], message: `duplicate session id: ${s.id}` });
      }
      ids.add(s.id);
    }
  });

export type SessionConfigEntry = z.infer<typeof SessionConfigSchema>;
export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {}

// Load + validate a config file. ${ENV_VAR} placeholders are expanded against process.env
// before parsing — missing env vars cause a hard ConfigError so we never silently boot
// with `undefined` slipping into a webhook URL or secret.
export async function loadConfig(filePath: string, env: NodeJS.ProcessEnv = process.env): Promise<Config> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (err) {
    throw new ConfigError(`failed to read config file ${filePath}: ${(err as Error).message}`);
  }
  const expanded = expandEnv(raw, env);
  let parsed: unknown;
  try {
    parsed = parseYaml(expanded);
  } catch (err) {
    throw new ConfigError(`config is not valid YAML: ${(err as Error).message}`);
  }
  const result = ConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new ConfigError(`config validation failed:\n${issues}`);
  }
  return result.data;
}

// Substitute ${VAR} (and ${VAR:-default}) with values from env. Throws if a var without
// a default is missing, so we fail at boot instead of mid-flight with a bad webhook URL.
export function expandEnv(input: string, env: NodeJS.ProcessEnv): string {
  return input.replace(/\$\{([A-Z_][A-Z0-9_]*)(?::-([^}]*))?\}/g, (_, name: string, fallback?: string) => {
    const v = env[name];
    if (v !== undefined && v !== "") return v;
    if (fallback !== undefined) return fallback;
    throw new ConfigError(`environment variable \${${name}} is not set (and no default provided)`);
  });
}
