import { afterEach, describe, expect, it, vi } from "vitest";
import { parseInitArgv } from "../src/cli/init";
import { buildLoginUrl } from "../src/cli/github-login";

function runParseArgv(args: string[]): { code: number; stdout: string; stderr: string } {
  let stderr = "";
  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation((chunk: string | Uint8Array) => {
      stderr += chunk.toString();
      return true;
    });
  const exitSpy = vi
    .spyOn(process, "exit")
    .mockImplementation(((code?: string | number | null) => {
      throw Object.assign(new Error("process.exit"), { code: Number(code ?? 0) });
    }) as never);

  try {
    return { code: 0, stdout: JSON.stringify(parseInitArgv(args)), stderr };
  } catch (e: any) {
    return {
      code: e.code ?? 1,
      stdout: "",
      stderr,
    };
  } finally {
    exitSpy.mockRestore();
    stderrSpy.mockRestore();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("CLI init — parseInitArgv", () => {
  it("parses empty arguments", () => {
    const { code, stdout } = runParseArgv([]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({});
  });

  it("parses --yes flag", () => {
    const { code, stdout } = runParseArgv(["--yes"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ yes: true });
  });

  it("parses -y shorthand", () => {
    const { code, stdout } = runParseArgv(["-y"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ yes: true });
  });

  it("parses all value flags", () => {
    const { code, stdout } = runParseArgv([
      "--agent-id", "test-agent",
      "--server", "http://localhost:3000",
      "--api-key", "sk_live_123",
      "--email", "test@example.com"
    ]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      agentId: "test-agent",
      server: "http://localhost:3000",
      apiKey: "sk_live_123",
      email: "test@example.com"
    });
  });

  it("parses single --client", () => {
    const { code, stdout } = runParseArgv(["--client", "cursor"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ clients: ["cursor"] });
  });

  it("parses comma-separated --client", () => {
    const { code, stdout } = runParseArgv(["--client", "cursor,continue"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ clients: ["cursor", "continue"] });
  });

  it("parses --all", () => {
    const { code, stdout } = runParseArgv(["--all"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ clients: ["all"] });
  });

  it("parses --github flag", () => {
    const { code, stdout } = runParseArgv(["--github"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ github: true });
  });

  it("parses --no-github flag", () => {
    const { code, stdout } = runParseArgv(["--no-github"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ noGithub: true });
  });

  it("parses --yes --github --all together", () => {
    const { code, stdout } = runParseArgv(["--yes", "--github", "--all"]);
    expect(code).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ yes: true, github: true, clients: ["all"] });
  });

  it("exits 1 on missing value for --server", () => {
    const { code, stderr } = runParseArgv(["--server"]);
    expect(code).toBe(1);
    expect(stderr).toContain("missing value for --server");
  });

  it("exits 1 on unknown argument", () => {
    const { code, stderr } = runParseArgv(["--unknown"]);
    expect(code).toBe(1);
    expect(stderr).toContain("unknown argument: --unknown");
  });
});

describe("CLI github login — buildLoginUrl (pure function)", () => {
  it("constructs the correct URL with all parameters", () => {
    const url = buildLoginUrl(
      "http://localhost:3000",
      "http://127.0.0.1:8080/callback",
      "test_state",
      "my-laptop"
    );

    const parsed = new URL(url);
    expect(parsed.origin).toBe("http://localhost:3000");
    expect(parsed.pathname).toBe("/auth/github");
    expect(parsed.searchParams.get("cli_redirect")).toBe("http://127.0.0.1:8080/callback");
    expect(parsed.searchParams.get("cli_state")).toBe("test_state");
    expect(parsed.searchParams.get("cli_label")).toBe("my-laptop");
  });

  it("omits cli_label when not provided", () => {
    const url = buildLoginUrl(
      "http://localhost:3000",
      "http://127.0.0.1:8080/callback",
      "test_state"
    );

    const parsed = new URL(url);
    expect(parsed.searchParams.has("cli_label")).toBe(false);
    expect(parsed.searchParams.get("cli_redirect")).toBe("http://127.0.0.1:8080/callback");
    expect(parsed.searchParams.get("cli_state")).toBe("test_state");
  });

  it("truncates long labels to 64 chars", () => {
    const longLabel = "a".repeat(100);
    const url = buildLoginUrl(
      "http://localhost:3000",
      "http://127.0.0.1:8080/callback",
      "state",
      longLabel
    );

    const parsed = new URL(url);
    expect(parsed.searchParams.get("cli_label")!.length).toBe(64);
  });
});
