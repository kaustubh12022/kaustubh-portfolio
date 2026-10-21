import Link from "next/link";

export default function NotFound() {
  return (
    <main className="paper-grain relative flex min-h-dvh items-center justify-center bg-paper px-5 py-16">
      <div className="pointer-events-none absolute inset-0 hero-grid" aria-hidden />

      <div className="relative w-full max-w-xl">
        <Link
          href="/"
          className="inline-flex h-9 w-9 items-center justify-center rounded-[11px] border border-line-strong/80 bg-white/70 font-display text-[15px] shadow-sm transition-opacity hover:opacity-80"
          aria-label="Kaustubh Kale — home"
        >
          KK
        </Link>

        <h1 className="mt-8 font-display text-[clamp(3rem,11vw,5.4rem)] leading-[0.9] tracking-[-0.035em] text-ink">
          Not found
        </h1>

        <p className="mt-5 max-w-[46ch] text-[15px] leading-[1.65] text-ink-soft">
          There is nothing at this address. The portfolio holds seven audited
          projects, and every claim on it points at source code a reviewer can
          open.
        </p>

        <div className="mt-8 flex flex-wrap items-center gap-2">
          <Link
            href="/"
            className="inline-flex items-center gap-1.5 rounded-full bg-ink px-4 py-2.5 text-[12.5px] text-paper transition-colors hover:bg-accent"
          >
            Ask the portfolio
          </Link>
          <Link
            href="/projects"
            className="inline-flex items-center gap-1.5 rounded-full border border-line bg-paper/70 px-4 py-2.5 text-[12.5px] text-ink-soft transition-colors hover:border-line-strong hover:text-ink"
          >
            Browse the projects
          </Link>
        </div>
      </div>
    </main>
  );
}
