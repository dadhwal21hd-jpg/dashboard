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

  // h-dvh, not h-screen: on a phone 100vh is the height with the browser's
  // toolbars hidden, so the bottom of the dashboard sat behind them.
  if (authStatus === "loading") {
    return (
      <div className="flex h-dvh items-center justify-center bg-stone-100">
        <Spinner />
      </div>
    );
  }

  return (
    <div className="flex h-dvh flex-col bg-stone-100">
      {/* Top bar */}
      <header className="flex items-center justify-between gap-3 border-b border-stone-200 bg-white px-3 py-2 shadow-sm sm:px-5 sm:py-3">
        <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
          <div className="h-7 w-7 shrink-0 rounded bg-[#b5622a] sm:h-8 sm:w-8" />
          <div className="min-w-0">
            <h1 className="text-sm font-semibold tracking-wide text-stone-900">
              SDWL AI LENS
            </h1>
            <p className="truncate text-[11px] text-stone-500">
              Signed in as {session?.user?.email}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1 sm:gap-2">
          <button
            onClick={handleRefresh}
            disabled={status === "loading"}
            className="rounded-md border border-stone-300 bg-white px-3 py-2 text-xs font-medium text-stone-700 transition hover:border-[#b5622a] hover:text-[#b5622a] disabled:cursor-not-allowed disabled:opacity-50 sm:py-1.5"
          >
            {status === "loading" ? (
              "Refreshing…"
            ) : (
              <>
                ↻ Refresh<span className="hidden sm:inline"> data</span>
              </>
            )}
          </button>
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="rounded-md px-2.5 py-2 text-xs font-medium text-stone-500 transition hover:text-stone-900 sm:px-3 sm:py-1.5"
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
              Syncing with the SDWL data core…
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
