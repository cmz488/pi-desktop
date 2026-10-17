/** Browser-side conservative contrast bounds for the static jelly backdrop.
 * Serialize this function into the isolated browser. Unlike a nearest-surface
 * check, it composites alpha through every ancestor and bounds gradient stops.
 * It covers our CSS color gradients, not arbitrary background images. */
export function measureSurfaceContrast(selectors, doc = document) {
  const style = (node) => doc.defaultView.getComputedStyle(node);
  const canvas = doc.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d", { willReadFrequently: true });
  const color = (value) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const rgba = [...context.getImageData(0, 0, 1, 1).data];
    rgba[3] /= 255;
    return rgba;
  };
  const over = (front, back) =>
    front.slice(0, 3).map((v, i) => v * front[3] + back[i] * (1 - front[3]));
  const bounds = (colors) => [
    [0, 1, 2].map((i) => Math.min(...colors.map((v) => v[i]))),
    [0, 1, 2].map((i) => Math.max(...colors.map((v) => v[i]))),
  ];
  const stops = (image) =>
    (image.match(/(?:rgba?|color)\([^)]*\)/g) ?? []).map(color);
  const luminance = (rgb) =>
    rgb.reduce((sum, v, i) => {
      const s = v / 255;
      return (
        sum +
        (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4) *
          [0.2126, 0.7152, 0.0722][i]
      );
    }, 0);

  // Parent and embedded renderer share this static backdrop. Resolve CSS hex
  // stops via the browser, then bound all possible mixes before the milk wash.
  const probe = doc.createElement("div");
  probe.hidden = true;
  probe.style.backgroundImage = "var(--ambient)";
  doc.body.append(probe);
  const bodyStyle = style(doc.body);
  const ambient = bounds([
    color(bodyStyle.getPropertyValue("--canvas")),
    ...stops(style(probe).backgroundImage).filter((v) => v[3] > 0),
  ]);
  probe.remove();
  const wash = color(bodyStyle.getPropertyValue("--shell-wash"));
  const backdrop = ambient.map((background) => over(wash, background));

  return selectors.flatMap((selector) => {
    const node = doc.querySelector(selector);
    if (!node || !node.getClientRects().length || node.disabled) return [];
    const ancestors = [];
    for (
      let current = node;
      current && current !== doc.body;
      current = current.parentElement
    )
      ancestors.unshift(current);
    let backgrounds = backdrop;
    for (const ancestor of ancestors) {
      const s = style(ancestor);
      backgrounds = backgrounds.map((background) =>
        over(color(s.backgroundColor), background),
      );
      const gradient = stops(s.backgroundImage);
      if (gradient.length)
        backgrounds = bounds(
          gradient.flatMap((stop) =>
            backgrounds.map((background) => over(stop, background)),
          ),
        );
    }
    const foreground = color(style(node).color);
    const [bgLow, bgHigh] = backgrounds.map(luminance);
    const [fgLow, fgHigh] = backgrounds.map((background) =>
      luminance(over(foreground, background)),
    );
    // A text luminance inside the background range can have contrast 1:1
    // BETWEEN gradient endpoints, even if both endpoints appear to pass.
    const ratio =
      fgLow > bgHigh
        ? (fgLow + 0.05) / (bgHigh + 0.05)
        : bgLow > fgHigh
          ? (bgLow + 0.05) / (fgHigh + 0.05)
          : 1;
    return [
      {
        selector,
        foreground: style(node).color,
        background: backgrounds
          .map((v) => `rgb(${v.map(Math.round).join(", ")})`)
          .join(" … "),
        ratio,
      },
    ];
  });
}
