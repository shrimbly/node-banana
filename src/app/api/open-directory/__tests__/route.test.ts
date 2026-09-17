// @vitest-environment node
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockExecFileAsync, mockStat, mockPlatform, mockHomedir } = vi.hoisted(() => ({
  mockExecFileAsync: vi.fn(),
  mockStat: vi.fn(),
  mockPlatform: vi.fn(),
  mockHomedir: vi.fn(),
}));

vi.mock(import("child_process"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, execFile: vi.fn() };
});

vi.mock(import("util"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, promisify: () => mockExecFileAsync };
});

vi.mock(import("fs/promises"), async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, stat: (...args: unknown[]) => mockStat(...args) };
});

vi.mock(import("os"), async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    default: { ...actual, platform: () => mockPlatform(), homedir: () => mockHomedir() },
    platform: () => mockPlatform(),
    homedir: () => mockHomedir(),
  };
});

import { POST } from "../route";

function createMockRequest(body: unknown, headers?: Record<string, string>): NextRequest {
  return {
    json: vi.fn().mockResolvedValue(body),
    headers: new Headers({ host: "localhost:3000", ...headers }),
  } as unknown as NextRequest;
}

describe("/api/open-directory route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPlatform.mockReturnValue("darwin");
    mockHomedir.mockReturnValue("/Users/testuser");
    mockStat.mockResolvedValue({ isDirectory: () => true });
    mockExecFileAsync.mockResolvedValue({ stdout: "", stderr: "" });
  });

  describe("localhost guard", () => {
    it("returns 403 for a non-localhost x-forwarded-for", async () => {
      const response = await POST(
        createMockRequest(
          { path: "/Users/testuser/projects" },
          { "x-forwarded-for": "203.0.113.50" }
        )
      );

      expect(response.status).toBe(403);
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it("returns 403 for a non-localhost host header", async () => {
      const response = await POST(
        createMockRequest(
          { path: "/Users/testuser/projects" },
          { host: "creative.example.com" }
        )
      );

      expect(response.status).toBe(403);
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it("allows a loopback request", async () => {
      const response = await POST(
        createMockRequest(
          { path: "/Users/testuser/projects" },
          { "x-forwarded-for": "127.0.0.1" }
        )
      );

      expect(response.status).toBe(200);
      expect(mockExecFileAsync).toHaveBeenCalled();
    });
  });

  describe("home directory restriction", () => {
    it("refuses to open a directory outside the home directory", async () => {
      const response = await POST(createMockRequest({ path: "/etc" }));

      expect(response.status).toBe(403);
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it("refuses a traversal that escapes the home directory", async () => {
      const response = await POST(
        createMockRequest({ path: "/Users/testuser/../../etc" })
      );

      expect(response.status).toBe(403);
      expect(mockExecFileAsync).not.toHaveBeenCalled();
    });

    it("allows a directory inside the home directory", async () => {
      const response = await POST(
        createMockRequest({ path: "/Users/testuser/projects/node-banana" })
      );

      expect(response.status).toBe(200);
      expect(mockExecFileAsync).toHaveBeenCalled();
    });
  });
});
