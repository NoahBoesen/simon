import { expect, test } from "vitest";
import { signupUrl } from "../app/lib/signupUrl";

test("a hosted QR uses the visited domain even if local LAN configuration was copied", () => {
  for (const origin of [
    "https://simon.example.com",
    "https://simon-preview.vercel.app",
  ]) {
    expect(
      signupUrl(origin, {
        hostedOnVercel: true,
        localPublicUrl: "http://192.168.1.20:3000",
      }),
    ).toBe(`${origin}/join`);
  }
});

test("local QR testing supports a phone-accessible LAN origin", () => {
  expect(
    signupUrl("http://localhost:3000", {
      localPublicUrl: "http://192.168.1.20:3000/",
    }),
  ).toBe("http://192.168.1.20:3000/join");
  expect(signupUrl("http://localhost:3000", {})).toBe(
    "http://localhost:3000/join",
  );
});
