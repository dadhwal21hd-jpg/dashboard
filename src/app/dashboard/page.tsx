"use client";

import { useEffect, useRef, useState } from "react";
import { signOut, useSession } from "next-auth/react";
import { useRouter } from "next/navigation";

type Status = "loading" | "ready" | "error";

export default function DashboardPage() {
  const { data: session, status: authStatus } = useSession();
  const router = useRouter();
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [status, setStatus] = useState<Status>("loading");
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [lastRefresh, setLastRefresh] = useState<number>(() => Date.now());

  // Redirect to /login if not signed in
  useEffect(() => {
    if (authStatus === "unauthenticated") router.replace("/login");
  }, [authStatus, router]);

  // Load dashboard HTML into the iframe via blob URL
  useEffect(() => {
    if (authStatus !== "authenticated") return;

    let cancelled = false;
    let blobUrl: string | null = null;

    (async () => {
      setStatus("loading");
      setErrorMsg("");
      try {
        const url = `/api/dashboard${lastRefresh ? `?t=${lastRefresh}` : ""}`;
        const res = await fetch(url, { cache: "no-store" });
        if (!res.ok) {
          let msg = `HTTP ${res.status}`;
          try {
            const j = await res.json();
            if (j?.error) msg = j.error;
          } catch { /* ignore */ }
          throw new Error(msg);
        }
        const html = await res.text();
        if (cancelled) return;

        const blob = new Blob([html], { type: "text/html" });
        blobUrl = URL.createObjectURL(blob);
        if (iframeRef.current) {
          iframeRef.current.src = blobUrl;
        }
        setStatus("ready");
      } catch (err) {
        if (cancelled) return;
        setErrorMsg(err instanceof Error ? err.message : "Failed to load dashboard");
        setStatus("error");
      }
    })();

    return () => {
      cancelled = true;
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [authStatus, lastRefresh]);

  const handleRefresh = async () => {
    // Bust the server cache too
    await fetch("/api/dashboard?refresh=1", { cache: "no-store" }).catch(() => {});
    setLastRefresh(Date.now());
  };

  if (authStatus === "loading") {
    return (
      <div className="flex h-screen items-center justify-center bg-stone-100">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col bg-stone-100">
      {/* Top bar */}
      <header className="flex items-center justify-between border-b border-stone-200 bg-white px-5 py-3 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="h-8 w-8 rounded bg-[#b5622a]" />
          <div>
            <h1 className="text-sm font-semibold tracking-wide text-stone-900">
              SDWL AI LENS
            </h1>
            <p className="text-[11px] text-stone-500">
              Signed in as {session?.user?.email}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleRefresh}
            disabled={status === "loading"}
            className="rounded-md border border-stone-300 bg-white px-3 py-1.5 text-xs font-medium text-stone-700 transition hover:border-[#b5622a] hover:text-[#b5622a] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {status === "loading" ? "Refreshing…" : "↻ Refresh data"}
          </button>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="rounded-md px-3 py-1.5 text-xs font-medium text-stone-500 transition hover:text-stone-900"
          >
            Sign out
          </button>
        </div>
      </header>

      {/* Body */}
      <main className="relative flex-1 overflow-hidden">
        {status === "loading" && (
          <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-3 bg-stone-100">
            <Spinner />
            <p className="text-xs font-medium uppercase tracking-wider text-stone-500">
              Pulling from Google Sheet…
            </p>
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 z-10 flex items-center justify-center bg-stone-100 px-6">
            <div className="max-w-md rounded-lg border border-red-200 bg-red-50 p-6 text-center">
              <h2 className="mb-2 text-base font-semibold text-red-900">
                Could not load dashboard
              </h2>
              <p className="mb-4 text-sm text-red-700">{errorMsg}</p>
              <button
                onClick={handleRefresh}
                className="rounded-md bg-red-600 px-4 py-2 text-sm font-medium text-white hover:bg-red-700"
              >
                Try again
              </button>
            </div>
          </div>
        )}
        <iframe
          ref={iframeRef}
          title="KK Dashboard"
          className="h-full w-full border-0"
        />
      </main>
    </div>
  );
}

function Spinner() {
  return (
    <div className="h-10 w-10 animate-spin rounded-full border-2 border-stone-300 border-t-[#b5622a]" />
  );
}
