import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, it } from "vitest";

const css = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");

type Rgb = [number, number, number];

function relativeLuminance([red, green, blue]: Rgb) {
  const [r, g, b] = [red, green, blue].map((channel) => {
    const srgb = channel / 255;
    return srgb <= 0.04045
      ? srgb / 12.92
      : ((srgb + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(first: Rgb, second: Rgb) {
  const lighter = Math.max(
    relativeLuminance(first),
    relativeLuminance(second),
  );
  const darker = Math.min(
    relativeLuminance(first),
    relativeLuminance(second),
  );
  return (lighter + 0.05) / (darker + 0.05);
}

function parseHex(value: string): Rgb {
  return [
    Number.parseInt(value.slice(1, 3), 16),
    Number.parseInt(value.slice(3, 5), 16),
    Number.parseInt(value.slice(5, 7), 16),
  ];
}

function composite(foreground: Rgb, background: Rgb, alpha: number): Rgb {
  return foreground.map(
    (channel, index) =>
      channel * alpha + background[index] * (1 - alpha),
  ) as Rgb;
}

it("keeps footer text above WCAG AA contrast with margin", () => {
  const launchShell = css.match(/^\.launch-shell\s*\{([\s\S]*?)^\}/mu);
  const footer = [...css.matchAll(/^footer\s*\{([\s\S]*?)^\}/gmu)].find(
    (block) => block[1].includes("color:"),
  );
  expect(launchShell).not.toBeNull();
  expect(footer).not.toBeNull();

  const backgroundStops = [
    ...new Set(launchShell?.[1].match(/#[0-9a-f]{6}/giu) ?? []),
  ].map(parseHex);
  const overlays = [
    ...(launchShell?.[1].matchAll(
      /rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/gu,
    ) ?? []),
  ].map((match) => ({
    color: [Number(match[1]), Number(match[2]), Number(match[3])] as Rgb,
    alpha: Number(match[4]),
  }));
  const footerColor = footer?.[1].match(
    /color:\s*rgba\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*([\d.]+)\s*\)/u,
  );
  expect(backgroundStops.length).toBeGreaterThanOrEqual(3);
  expect(overlays.length).toBeGreaterThanOrEqual(2);
  expect(footerColor).not.toBeNull();

  const foreground: Rgb = [
    Number(footerColor?.[1]),
    Number(footerColor?.[2]),
    Number(footerColor?.[3]),
  ];
  const alpha = Number(footerColor?.[4]);
  const renderedBackgrounds = backgroundStops.flatMap((background) => [
    background,
    ...overlays.map((overlay) =>
      composite(overlay.color, background, overlay.alpha),
    ),
  ]);
  const minimumContrast = Math.min(
    ...renderedBackgrounds.map((background) =>
      contrastRatio(composite(foreground, background, alpha), background),
    ),
  );

  expect(minimumContrast).toBeGreaterThanOrEqual(4.75);
});
