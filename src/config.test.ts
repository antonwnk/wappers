import { describe, it, expect } from "vitest";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, expandEnv, ConfigError } from "./config.js";

async function writeYaml(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "wappers-cfg-"));
  const file = join(dir, "config.yaml");
  await writeFile(file, content, "utf8");
  return file;
}

describe("expandEnv", () => {
  const env = { FOO: "bar", EMPTY: "", PORT: "3001" };

  it("substitutes ${VAR} with env value", () => {
    expect(expandEnv("a-${FOO}-b", env)).toBe("a-bar-b");
  });

  it("substitutes multiple occurrences", () => {
    expect(expandEnv("${FOO}/${PORT}", env)).toBe("bar/3001");
  });

  it("supports ${VAR:-default} fallback", () => {
    expect(expandEnv("${MISSING:-fallback}", env)).toBe("fallback");
    expect(expandEnv("${FOO:-fallback}", env)).toBe("bar");
  });

  it("treats empty string as missing for default fallback", () => {
    expect(expandEnv("${EMPTY:-defaulted}", env)).toBe("defaulted");
  });

  it("throws ConfigError for undefined var without default", () => {
    expect(() => expandEnv("hello-${MISSING}", env)).toThrow(ConfigError);
  });

  it("ignores text that doesn't match the placeholder pattern", () => {
    expect(expandEnv("$FOO and {FOO} and ${lowercase}", env)).toBe("$FOO and {FOO} and ${lowercase}");
  });
});

describe("loadConfig", () => {
  const env = {
    WEBHOOK_SECRET_MAIN: "supersecret123",
    WEBHOOK_SECRET_SUPPORT: "anothersecret456",
  };

  it("loads a minimal valid config", async () => {
    const file = await writeYaml(`
sessions:
  - id: main
    webhookUrl: https://example.com/hook
    webhookSecret: \${WEBHOOK_SECRET_MAIN}
`);
    const cfg = await loadConfig(file, env);
    expect(cfg.sessions).toHaveLength(1);
    expect(cfg.sessions[0]!.webhookSecret).toBe("supersecret123");
    expect(cfg.dataDir).toBe("./data");
    expect(cfg.http.port).toBe(3000);
  });

  it("supports multiple sessions with different secrets", async () => {
    const file = await writeYaml(`
dataDir: /var/lib/wappers
sessions:
  - id: main
    webhookUrl: https://main.example/hook
    webhookSecret: \${WEBHOOK_SECRET_MAIN}
  - id: support
    webhookUrl: https://support.example/hook
    webhookSecret: \${WEBHOOK_SECRET_SUPPORT}
`);
    const cfg = await loadConfig(file, env);
    expect(cfg.sessions.map((s) => s.id)).toEqual(["main", "support"]);
    expect(cfg.dataDir).toBe("/var/lib/wappers");
  });

  it("rejects duplicate session ids", async () => {
    const file = await writeYaml(`
sessions:
  - id: dup
    webhookUrl: https://a.example/hook
    webhookSecret: \${WEBHOOK_SECRET_MAIN}
  - id: dup
    webhookUrl: https://b.example/hook
    webhookSecret: \${WEBHOOK_SECRET_SUPPORT}
`);
    await expect(loadConfig(file, env)).rejects.toThrow(/duplicate session id: dup/);
  });

  it("rejects invalid webhookUrl", async () => {
    const file = await writeYaml(`
sessions:
  - id: main
    webhookUrl: not-a-url
    webhookSecret: \${WEBHOOK_SECRET_MAIN}
`);
    await expect(loadConfig(file, env)).rejects.toThrow(/webhookUrl/);
  });

  it("rejects short webhook secrets", async () => {
    const file = await writeYaml(`
sessions:
  - id: main
    webhookUrl: https://example.com/hook
    webhookSecret: short
`);
    await expect(loadConfig(file, env)).rejects.toThrow(/webhookSecret/);
  });

  it("rejects when sessions is empty", async () => {
    const file = await writeYaml(`sessions: []`);
    await expect(loadConfig(file, env)).rejects.toThrow(/at least one session/);
  });

  it("throws on missing env var (no silent undefined webhook URL)", async () => {
    const file = await writeYaml(`
sessions:
  - id: main
    webhookUrl: \${UNSET_VAR}
    webhookSecret: \${WEBHOOK_SECRET_MAIN}
`);
    await expect(loadConfig(file, env)).rejects.toThrow(/UNSET_VAR/);
  });

  it("throws ConfigError when the file is missing", async () => {
    await expect(loadConfig("/no/such/path.yaml", env)).rejects.toThrow(ConfigError);
  });

  it("rejects session ids with invalid characters", async () => {
    const file = await writeYaml(`
sessions:
  - id: "with spaces"
    webhookUrl: https://example.com/hook
    webhookSecret: \${WEBHOOK_SECRET_MAIN}
`);
    await expect(loadConfig(file, env)).rejects.toThrow();
  });
});
