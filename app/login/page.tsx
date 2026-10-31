"use client";

import { FormEvent, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAction } from "convex/react";
import { api } from "../../convex/_generated/api";
import { useSessionToken } from "../lib/useSession";

export default function Login() {
  const router = useRouter();
  const login = useAction(api.auth.login);
  const { save } = useSessionToken();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    const res = await login({ email, password });
    if (res.ok) {
      save(res.token);
      router.push("/host");
    } else {
      setError(res.error);
      setBusy(false);
    }
  }

  return (
    <main className="max-w-sm mx-auto px-6 pt-20 pb-20 w-full">
      <Link href="/" className="font-semibold tracking-tight text-xl block mb-10">
        simon
      </Link>
      <h1 className="text-2xl font-semibold tracking-tight mb-1">Host login</h1>
      <p className="text-sm text-zinc-500 mb-8">Back to your room.</p>

      <form onSubmit={submit} className="space-y-3">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="Email"
          autoComplete="email"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm outline-none focus:border-zinc-600 placeholder:text-zinc-600"
        />
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="Password"
          autoComplete="current-password"
          className="w-full bg-zinc-900 border border-zinc-800 rounded-lg px-4 py-3 text-sm outline-none focus:border-zinc-600 placeholder:text-zinc-600"
        />
        {error && <p className="text-xs text-red-400">{error}</p>}
        <button
          type="submit"
          disabled={busy || !email || !password}
          className="w-full bg-zinc-100 disabled:opacity-30 text-zinc-950 font-semibold rounded-lg py-3 text-sm hover:bg-white"
        >
          {busy ? "One sec" : "Log in"}
        </button>
      </form>

      <p className="text-xs text-zinc-600 mt-6">
        New here?{" "}
        <Link href="/signup" className="text-zinc-300 underline underline-offset-2">
          Create a host account
        </Link>
      </p>
    </main>
  );
}
