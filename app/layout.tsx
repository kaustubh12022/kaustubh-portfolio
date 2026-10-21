import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";

import "./globals.css";

const geist = Geist({
  subsets: ["latin"],
  variable: "--font-geist",
  display: "swap",
});

const geistMono = Geist_Mono({
  subsets: ["latin"],
  variable: "--font-geist-mono",
  display: "swap",
});

/**
 * Instrument Serif is loaded with BOTH styles.
 *
 * The display font is rendered with `italic` in a few places (the hero
 * name, the card headings). Loading only `weight: "400"` meant the browser
 * had no real oblique and synthesised one by slanting the glyphs, which
 * looks noticeably worse than the typeface's own italic.
 */
const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument",
  display: "swap",
});

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ?? "http://localhost:3000";

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  title: {
    default: "Kaustubh Kale — AI, automation, and backend systems",
    template: "%s · Kaustubh Kale",
  },
  description:
    "Ask Kaustubh Kale about his AI automation, agentic tools, backend systems, and the code behind them.",
  alternates: {
    canonical: "/",
  },
  openGraph: {
    title: "Kaustubh Kale — AI, automation, and backend systems",
    description:
      "A conversational portfolio grounded in real source code, with evidence for every answer.",
    url: siteUrl,
    siteName: "Kaustubh Kale",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "Kaustubh Kale — AI, automation, and backend systems",
    description:
      "A conversational portfolio grounded in real source code, with evidence for every answer.",
  },
  robots: {
    index: true,
    follow: true,
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#f7f5ef",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${geist.variable} ${geistMono.variable} ${instrumentSerif.variable} font-sans antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
