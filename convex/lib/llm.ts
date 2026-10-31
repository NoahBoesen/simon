const MODEL = "claude-sonnet-4-6";

export async function claude(
  system: string,
  user: string,
  maxTokens = 1024
): Promise<string> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY not set in Convex env");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": key,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: user }],
    }),
  });
  if (!res.ok) {
    throw new Error(`Anthropic ${res.status}: ${await res.text()}`);
  }
  const data = await res.json();
  return data.content?.[0]?.text ?? "";
}

export function parseJson<T>(raw: string, fallback: T): T {
  try {
    const cleaned = raw
      .replace(/^```(json)?/m, "")
      .replace(/```\s*$/m, "")
      .trim();
    const start = cleaned.indexOf(cleaned.trimStart().startsWith("[") ? "[" : "{");
    return JSON.parse(cleaned.slice(start)) as T;
  } catch {
    return fallback;
  }
}
