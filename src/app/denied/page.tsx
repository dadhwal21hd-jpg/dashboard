"use client";

import Link from "next/link";
import { signOut } from "next-auth/react";

export default function DeniedPage() {
  return (
    <main className="flex flex-1 items-center justify-center bg-stone-100 px-6">
      <div className="max-w-md text-center">
        <div className="mx-auto mb-6 flex h-16 w-16 items-center justify-center rounded-full bg-amber-100">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="text-amber-700" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="8" x2="12" y2="12" />
            <line x1="12" y1="16" x2="12.01" y2="16" />
          </svg>
        </div>
        <h1 className="mb-3 text-2xl font-semibold tracking-tight text-stone-900">
          Access not authorised
        </h1>
        <p className="mb-6 text-sm leading-relaxed text-stone-600">
          Your Google account isn&apos;t on the access list for this dashboard.
          If you believe this is a mistake, ask your administrator to add your
          email address.
        </p>
        <div className="flex flex-col items-center gap-3">
          <button
            onClick={() => signOut({ callbackUrl: "/login" })}
            className="rounded-md bg-stone-900 px-5 py-2 text-sm font-medium text-white hover:bg-stone-800"
          >
            Sign out and try again
          </button>
          <Link href="/login" className="text-xs text-stone-500 hover:text-stone-900">
            Back to login
          </Link>
        </div>
      </div>
    </main>
  );
}
