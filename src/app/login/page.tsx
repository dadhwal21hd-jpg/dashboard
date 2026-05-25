"use client";

import { Suspense, useEffect, useState } from "react";
import { signIn, useSession } from "next-auth/react";
import { useRouter, useSearchParams } from "next/navigation";

export default function LoginPage() {
  return (
    <Suspense fallback={<LoginFallback />}>
      <LoginInner />
    </Suspense>
  );
}

function LoginFallback() {
  return (
    <main className="flex flex-1 items-center justify-center bg-stone-100 px-6">
      <div className="h-10 w-10 animate-spin rounded-full border-2 border-stone-300 border-t-[#b5622a]" />
    </main>
  );
}

function LoginInner() {
  const { status } = useSession();
  const router = useRouter();
  const params = useSearchParams();
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (status === "authenticated") {
      router.replace("/dashboard");
    }
  }, [status, router]);

  const error = params.get("error");

  return (
    <main className="flex flex-1 items-center justify-center bg-stone-100 px-6">
      <div className="w-full max-w-md">
        <div className="rounded-2xl border border-stone-200 bg-white p-10 shadow-sm">
          <div className="mb-8 flex items-center gap-3">
            <div className="h-10 w-10 rounded-md bg-[#b5622a]" />
            <div>
              <h1 className="text-base font-semibold text-stone-900">
                SDWL AI LENS
              </h1>
              <p className="text-xs text-stone-500">Sales analytics dashboard</p>
            </div>
          </div>

          <h2 className="mb-2 text-2xl font-semibold tracking-tight text-stone-900">
            Welcome back
          </h2>
          <p className="mb-8 text-sm text-stone-600">
            Sign in with your authorised Google account to view the dashboard.
          </p>

          {error && (
            <div className="mb-6 rounded-md border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
              Sign-in failed. Please try again or contact your administrator.
            </div>
          )}

          <button
            disabled={loading}
            onClick={() => {
              setLoading(true);
              signIn("google", { callbackUrl: "/dashboard" });
            }}
            className="flex w-full items-center justify-center gap-3 rounded-md border border-stone-300 bg-white px-4 py-3 text-sm font-medium text-stone-800 transition hover:border-stone-400 hover:bg-stone-50 disabled:opacity-50"
          >
            <GoogleIcon />
            {loading ? "Redirecting…" : "Sign in with Google"}
          </button>

          <p className="mt-6 text-center text-[11px] text-stone-400">
            Access is restricted to authorised email addresses.
          </p>
        </div>
      </div>
    </main>
  );
}

function GoogleIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.637-.057-1.251-.164-1.84H9v3.481h4.844a4.14 4.14 0 0 1-1.796 2.716v2.258h2.908c1.702-1.567 2.684-3.874 2.684-6.615z"/>
      <path fill="#34A853" d="M9 18c2.43 0 4.467-.806 5.956-2.18l-2.908-2.259c-.806.54-1.837.86-3.048.86-2.344 0-4.328-1.584-5.036-3.711H.957v2.332A8.997 8.997 0 0 0 9 18z"/>
      <path fill="#FBBC05" d="M3.964 10.71A5.41 5.41 0 0 1 3.682 9c0-.593.102-1.17.282-1.71V4.958H.957A8.996 8.996 0 0 0 0 9c0 1.452.348 2.827.957 4.042l3.007-2.332z"/>
      <path fill="#EA4335" d="M9 3.58c1.321 0 2.508.454 3.44 1.345l2.582-2.58C13.463.891 11.426 0 9 0A8.997 8.997 0 0 0 .957 4.958L3.964 7.29C4.672 5.163 6.656 3.58 9 3.58z"/>
    </svg>
  );
}
