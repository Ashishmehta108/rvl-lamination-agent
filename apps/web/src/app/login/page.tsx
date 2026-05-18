"use client";

import { useState, FormEvent } from "react";

export default function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setLoading(true);

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, password })
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data?.error ?? "Login failed. Please check your credentials.");
        return;
      }

      // Hard redirect so the Edge middleware sees the fresh cookie
      window.location.href = "/";
    } catch {
      setError("Network error — please try again.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg)] text-[var(--text)] transition-colors duration-300 relative overflow-hidden">
      {/* Dynamic tactile ambient lighting */}
      <div className="absolute inset-0 overflow-hidden pointer-events-none">
        <div className="absolute -top-48 -left-48 w-[500px] h-[500px] bg-[var(--accent)]/5 rounded-full blur-[120px] opacity-70" />
        <div className="absolute -bottom-48 -right-48 w-[500px] h-[500px] bg-[var(--accent)]/10 rounded-full blur-[120px] opacity-70" />
      </div>

      <div className="relative w-full max-w-md mx-4 z-10">
        {/* Card wrapper with premium subtle shadows and border */}
        <div className="bg-[var(--surface)] border border-[var(--border)] rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.06)] dark:shadow-[0_8px_30px_rgba(0,0,0,0.3)] p-8 transition-all duration-300">
          
          {/* Header Brand Block */}
          <div className="mb-8 text-center">
            <div className="inline-flex items-center justify-center w-14 h-14 rounded-2xl bg-[var(--accent-faint)] border border-[var(--accent)]/20 mb-4 shadow-sm transition-transform duration-300 hover:scale-105">
              <svg
                className="w-7 h-7 text-[var(--accent)]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={1.5}
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M9 12.75L11.25 15 15 9.75m-3-7.036A11.959 11.959 0 013.598 6 11.99 11.99 0 003 9.749c0 5.592 3.824 10.29 9 11.623 5.176-1.332 9-6.03 9-11.622 0-1.31-.21-2.571-.598-3.751h-.152c-3.196 0-6.1-1.248-8.25-3.285z"
                />
              </svg>
            </div>
            <h1 className="text-2xl font-bold tracking-tight text-[var(--text)]">RVL Lamination AI</h1>
            <p className="mt-2 text-sm text-[var(--text-muted)] font-medium">Sign in to your workspace</p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Email Field */}
            <div className="space-y-1.5">
              <label htmlFor="login-email" className="block text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                Email address
              </label>
              <input
                id="login-email"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="operator@plant.com"
                className="w-full px-4 py-2.5 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text)] placeholder-[var(--text-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/15 focus:border-[var(--accent)] transition-all duration-200"
              />
            </div>

            {/* Password Field */}
            <div className="space-y-1.5">
              <div className="flex items-center justify-between">
                <label htmlFor="login-password" className="block text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  Password
                </label>
              </div>
              <input
                id="login-password"
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                className="w-full px-4 py-2.5 rounded-xl bg-[var(--surface-2)] border border-[var(--border)] text-[var(--text)] placeholder-[var(--text-faint)] focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/15 focus:border-[var(--accent)] transition-all duration-200"
              />
            </div>

            {/* Error Message */}
            {error && (
              <div
                role="alert"
                className="flex items-start gap-3 rounded-xl bg-red-500/10 border border-red-500/20 px-4 py-3 text-red-600 dark:text-red-400"
              >
                <svg className="w-5 h-5 mt-0.5 shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                  <path strokeLinecap="round" strokeLinejoin="round" d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
                </svg>
                <p className="text-sm font-medium leading-relaxed">{error}</p>
              </div>
            )}

            {/* Submit Button */}
            <button
              id="login-submit-btn"
              type="submit"
              disabled={loading}
              className="w-full py-3 px-4 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:bg-[var(--accent)]/50 disabled:cursor-not-allowed text-white font-semibold text-sm transition-all duration-200 shadow-sm focus:outline-none focus:ring-2 focus:ring-[var(--accent)]/50 focus:ring-offset-2 focus:ring-offset-[var(--bg)]"
            >
              {loading ? (
                <span className="flex items-center justify-center gap-2">
                  <svg className="animate-spin h-4 w-4 text-white" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                    <path
                      className="opacity-75"
                      fill="currentColor"
                      d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z"
                    />
                  </svg>
                  Signing in…
                </span>
              ) : (
                "Sign in"
              )}
            </button>
          </form>

          <p className="mt-8 text-center text-xs text-[var(--text-faint)] font-medium">
            Contact your administrator to create an account.
          </p>
        </div>
      </div>
    </div>
  );
}
