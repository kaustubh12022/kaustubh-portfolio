import { ImageResponse } from "next/og";

/**
 * The favicon / app icon: the same "KK" monogram as the site header, in the
 * accent colour so it stays legible on a light browser tab.
 *
 * Satori cannot use `next/font`, so the default font bundled with
 * `next/og` is used and the styles are inline only.
 */

export const size = {
  width: 32,
  height: 32,
};
export const contentType = "image/png";

export default function Icon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          backgroundColor: "#2F4BFF",
          color: "#F7F5EF",
          fontSize: 17,
          letterSpacing: "-0.02em",
        }}
      >
        KK
      </div>
    ),
    { ...size },
  );
}
