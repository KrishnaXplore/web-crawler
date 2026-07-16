import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ApiError } from "@google/genai";

const generateContentMock = vi.fn();

vi.mock("@google/genai", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@google/genai")>();
  return {
    ...actual,
    GoogleGenAI: vi.fn().mockImplementation(() => ({
      models: { generateContent: generateContentMock },
    })),
  };
});

const { createGeminiLlmSocket } = await import("./socket.js");

function okResponse(fields: { name: string; selector: string }[]) {
  return { text: JSON.stringify({ schemaType: "Product", fields }) };
}

describe("createGeminiLlmSocket rate-limit retry (M20)", () => {
  beforeEach(() => {
    generateContentMock.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries once on a 429 and succeeds on the second attempt", async () => {
    generateContentMock
      .mockRejectedValueOnce(new ApiError({ message: "rate limited", status: 429 }))
      .mockResolvedValueOnce(okResponse([{ name: "price", selector: ".price" }]));

    const socket = createGeminiLlmSocket({ apiKey: "test-key" });
    const promise = socket.generateRules("example.com", "<html></html>", "extract the price");
    await vi.advanceTimersByTimeAsync(5_000);
    const rule = await promise;

    expect(rule.fields).toEqual({ price: ".price" });
    expect(generateContentMock).toHaveBeenCalledTimes(2);
  });

  it("propagates a second consecutive 429 instead of retrying indefinitely", async () => {
    generateContentMock.mockRejectedValue(new ApiError({ message: "rate limited", status: 429 }));

    const socket = createGeminiLlmSocket({ apiKey: "test-key" });
    const promise = socket.generateRules("example.com", "<html></html>", "extract the price");
    const assertion = expect(promise).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(5_000);
    await assertion;

    expect(generateContentMock).toHaveBeenCalledTimes(2); // original + one retry, no more
  });

  it("does not retry on a non-429 error", async () => {
    generateContentMock.mockRejectedValue(new ApiError({ message: "bad request", status: 400 }));

    const socket = createGeminiLlmSocket({ apiKey: "test-key" });
    await expect(
      socket.generateRules("example.com", "<html></html>", "extract the price"),
    ).rejects.toThrow();

    expect(generateContentMock).toHaveBeenCalledTimes(1);
  });
});
