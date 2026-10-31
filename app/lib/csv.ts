export type GuestRow = {
  name: string;
  email?: string;
  phone?: string;
  linkedin?: string;
  bio?: string;
};

export function parseCsv(text: string): GuestRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 2) return [];
  const split = (line: string) =>
    line
      .match(/("([^"]|"")*"|[^,]*)(,|$)/g)
      ?.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").trim())
      .slice(0, -1) ?? line.split(",");
  const headers = split(lines[0]).map((h) => h.toLowerCase());
  const col = (names: string[]) =>
    headers.findIndex((h) => names.some((n) => h.includes(n)));
  const nameIdx = col(["name"]);
  const emailIdx = col(["email"]);
  const phoneIdx = col(["phone", "mobile"]);
  const linkedinIdx = col(["linkedin"]);
  const bioIdx = col(["bio", "about"]);
  if (nameIdx === -1) return [];
  return lines.slice(1).map((line) => {
    const cells = split(line);
    return {
      name: cells[nameIdx] ?? "",
      email: emailIdx >= 0 ? cells[emailIdx] || undefined : undefined,
      phone: phoneIdx >= 0 ? cells[phoneIdx] || undefined : undefined,
      linkedin: linkedinIdx >= 0 ? cells[linkedinIdx] || undefined : undefined,
      bio: bioIdx >= 0 ? cells[bioIdx] || undefined : undefined,
    };
  });
}
