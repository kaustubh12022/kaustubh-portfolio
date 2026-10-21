import { ImageResponse } from "next/og";

/**
 * The Open Graph card.
 *
 * Satori cannot use `next/font`, so this uses the default font that ships
 * with `next/og` and inline styles only. The colours are the same tokens
 * the site itself uses.
 */

export const alt = "Kaustubh Kale — Graduate Engineer, Pune, India";
export const size = {
  width: 1200,
  height: 630,
};
export const contentType = "image/png";

const PAPER = "#F7F5EF";
const INK = "#14130F";
const MUTED = "#6B675C";
const LINE = "#E2DED2";
const ACCENT = "#2F4BFF";

export default async function Image() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          backgroundColor: PAPER,
          padding: "60px 68px",
          borderTopWidth: 14,
          borderTopStyle: "solid",
          borderTopColor: ACCENT,
        }}
      >
        {/* Monogram, name and headline */}
        <div style={{ display: "flex", alignItems: "center", gap: 26 }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              width: 104,
              height: 104,
              borderRadius: 28,
              backgroundColor: ACCENT,
              color: PAPER,
              fontSize: 46,
              letterSpacing: "-0.02em",
            }}
          >
            KK
          </div>
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div
              style={{
                display: "flex",
                fontSize: 54,
                color: INK,
                letterSpacing: "-0.025em",
              }}
            >
              Kaustubh Kale
            </div>
            <div
              style={{
                display: "flex",
                marginTop: 8,
                fontSize: 28,
                color: MUTED,
              }}
            >
              Graduate Engineer
            </div>
          </div>
        </div>

        {/* What the portfolio is */}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: 16,
            maxWidth: 900,
          }}
        >
          <div style={{ display: "flex", fontSize: 38, color: INK }}>
            AI, automation, and backend systems.
          </div>
          <div style={{ display: "flex", fontSize: 25, color: MUTED }}>
            A conversational portfolio grounded in real source code, with
            evidence for every answer.
          </div>
        </div>

        {/* Location and availability */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            borderTopWidth: 2,
            borderTopStyle: "solid",
            borderTopColor: LINE,
            paddingTop: 28,
            fontSize: 25,
            color: MUTED,
          }}
        >
          <div style={{ display: "flex" }}>Pune, Maharashtra, India</div>
          <div style={{ display: "flex", color: ACCENT }}>Open to roles</div>
        </div>
      </div>
    ),
    { ...size },
  );
}
