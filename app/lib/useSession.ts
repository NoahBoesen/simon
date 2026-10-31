"use client";

import { useEffect, useState } from "react";

const KEY = "simon_session";

export function useSessionToken() {
  const [token, setToken] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setToken(localStorage.getItem(KEY));
    setLoaded(true);
  }, []);

  return {
    token,
    loaded,
    save(t: string) {
      localStorage.setItem(KEY, t);
      setToken(t);
    },
    clear() {
      localStorage.removeItem(KEY);
      setToken(null);
    },
  };
}
