import { afterEach, expect, test, vi } from "vitest";
import { claudeJson } from "../convex/lib/llm";
import { agentResultSchema } from "../convex/lib/agentResultSchema";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

test("attendee replies request provider-enforced JSON with the action schema", async () => {
  vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
  const result = { reply: "Who would you like to meet?", actions: [] };
  const fetchMock = vi.fn().mockResolvedValue(
    Response.json({
      content: [{ type: "text", text: JSON.stringify(result) }],
      stop_reason: "end_turn",
    }),
  );
  vi.stubGlobal("fetch", fetchMock);
  expect(await claudeJson("System", "Hi", agentResultSchema)).toEqual(result);
  expect(JSON.parse(fetchMock.mock.calls[0][1].body).output_config).toEqual({
    format: { type: "json_schema", schema: agentResultSchema },
  });
});

test.each([
  ["end_turn", "Here are some people", "invalid structured JSON"],
  ["max_tokens", '{"reply":', "incomplete reply"],
  ["refusal", "Unable to fulfill this request", "declined"],
])(
  "%s invalid output is an error rather than a successful generic reply",
  async (stop, text, error) => {
    vi.stubEnv("ANTHROPIC_API_KEY", "test-key");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        Response.json({
          content: [{ type: "text", text }],
          stop_reason: stop,
        }),
      ),
    );
    await expect(claudeJson("System", "Hi", agentResultSchema)).rejects.toThrow(
      error,
    );
  },
);
