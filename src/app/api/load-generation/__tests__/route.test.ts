import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";

const mockStat = vi.fn();
const mockAccess = vi.fn();
const mockReadFile = vi.fn();

vi.mock("fs/promises", () => ({
  stat: (...args: unknown[]) => mockStat(...args),
  access: (...args: unknown[]) => mockAccess(...args),
  readFile: (...args: unknown[]) => mockReadFile(...args),
}));

vi.mock("@/utils/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST } from "../route";

function createMockPostRequest(body: unknown): NextRequest {
  return { json: vi.fn().mockResolvedValue(body) } as unknown as NextRequest;
}

describe("/api/load-generation route", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStat.mockResolvedValue({ isDirectory: () => true });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("directory path validation", () => {
    it("rejects a relative directoryPath", async () => {
      const response = await POST(
        createMockPostRequest({ directoryPath: "relative/dir", imageId: "img-abc" })
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(mockReadFile).not.toHaveBeenCalled();
    });

    it("rejects a directoryPath pointing at a system directory", async () => {
      const response = await POST(
        createMockPostRequest({ directoryPath: "/etc", imageId: "img-abc" })
      );
      const data = await response.json();

      expect(response.status).toBe(400);
      expect(data.success).toBe(false);
      expect(mockAccess).not.toHaveBeenCalled();
      expect(mockReadFile).not.toHaveBeenCalled();
    });
  });

  describe("imageId validation", () => {
    const traversalIds = [
      "../../../etc/passwd",
      "..%2F..%2Fetc%2Fpasswd",
      "sub/dir/img-abc",
      "img\\..\\..\\secret",
    ];

    for (const imageId of traversalIds) {
      it(`rejects an imageId escaping the directory: ${imageId}`, async () => {
        const response = await POST(
          createMockPostRequest({ directoryPath: "/tmp/generations", imageId })
        );
        const data = await response.json();

        expect(response.status).toBe(400);
        expect(data.success).toBe(false);
        expect(mockAccess).not.toHaveBeenCalled();
        expect(mockReadFile).not.toHaveBeenCalled();
      });
    }

    it("still accepts the id format the app actually generates", async () => {
      mockAccess.mockResolvedValue(undefined);
      mockReadFile.mockResolvedValue(Buffer.from("pixels"));

      const response = await POST(
        createMockPostRequest({ directoryPath: "/tmp/generations", imageId: "img-mcx1a2-Zk9Qw3" })
      );
      const data = await response.json();

      expect(response.status).toBe(200);
      expect(data.success).toBe(true);
      expect(mockReadFile).toHaveBeenCalled();
    });
  });
});
