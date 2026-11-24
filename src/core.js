export const SETTINGS = {
  fps: 20,
  speedMax: 120,
  kdeResolution: 450,
  mwm: {
    cx: 265,
    cy: 270,
    radius: 268,
    xRange: [-3, 533],
    yRange: [2, 538],
    kdeBandwidth: 15,
    speedMax: 120,
  },
  of: {
    xRange: [0, 200],
    yRange: [0, 200],
    kdeBandwidth: 15,
    speedMax: 200,
  },
};

const NUMBER_RE = /-?\d+\.?\d*/g;

function decodeBytes(arrayBuffer) {
  return new TextDecoder("utf-8", { fatal: false })
    .decode(new Uint8Array(arrayBuffer))
    .replaceAll("\u0000", "");
}

function parseStandardXY(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 101) return [];
  const split = (line) => line.split(",").map((cell) => cell.trim().replace(/^"|"$/g, ""));
  const header = split(lines[0]).map((cell) => cell.toLowerCase());
  const xIndex = header.indexOf("x");
  const yIndex = header.indexOf("y");
  if (xIndex < 0 || yIndex < 0) return [];
  const points = [];
  for (const line of lines.slice(1)) {
    const cells = split(line);
    const x = Number(cells[xIndex]);
    const y = Number(cells[yIndex]);
    if (Number.isFinite(x) && Number.isFinite(y)) points.push([x, y]);
  }
  return points;
}

export function parseCoordinateBuffer(arrayBuffer) {
  const text = decodeBytes(arrayBuffer);
  // Keep the original R script's behaviour: extract every number and pair them
  // in sequence. Standard x/y CSV is retained as a safe fallback.
  const numbers = [...text.matchAll(NUMBER_RE)].map((match) => Number(match[0]));
  let raw = [];
  for (let index = 0; index + 1 < numbers.length; index += 2) raw.push([numbers[index], numbers[index + 1]]);
  const standard = parseStandardXY(text);
  if (standard.length >= 100 && (raw.length < 100 || numbers.length !== standard.length * 2)) raw = standard;
  if (raw.length < 100) {
    throw new Error("未检测到逐帧 x,y 坐标；可能是汇总表或事件表");
  }
  return raw.map(([x, y]) => ({
    x,
    y,
    valid: Number.isFinite(x) && Number.isFinite(y),
  }));
}

export function transformPoints(points, kind) {
  if (kind !== "mwm") return points.map((point) => ({ ...point }));
  return points.map((point) => ({
    ...point,
    y: point.valid ? 2 * SETTINGS.mwm.cy - point.y : point.y,
  }));
}

export function createSpeedSegments(points, fps = SETTINGS.fps) {
  const segments = [];
  for (let i = 1; i < points.length; i += 1) {
    const previous = points[i - 1];
    const current = points[i];
    if (!previous.valid || !current.valid) continue;
    const speed = Math.hypot(current.x - previous.x, current.y - previous.y) * fps;
    segments.push({ x1: previous.x, y1: previous.y, x2: current.x, y2: current.y, speed });
  }
  return segments;
}

function gaussianKernel(sigma) {
  const radius = Math.max(1, Math.ceil(3 * sigma));
  const kernel = new Float32Array(radius * 2 + 1);
  let total = 0;
  for (let i = -radius; i <= radius; i += 1) {
    const value = Math.exp(-(i * i) / (2 * sigma * sigma));
    kernel[i + radius] = value;
    total += value;
  }
  for (let i = 0; i < kernel.length; i += 1) kernel[i] /= total;
  return { kernel, radius };
}

function gaussianBlur(source, width, height, sigmaX, sigmaY) {
  const xKernel = gaussianKernel(sigmaX);
  const yKernel = gaussianKernel(sigmaY);
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let offset = -xKernel.radius; offset <= xKernel.radius; offset += 1) {
        const xx = x + offset;
        if (xx >= 0 && xx < width) sum += source[y * width + xx] * xKernel.kernel[offset + xKernel.radius];
      }
      horizontal[y * width + x] = sum;
    }
  }
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      let sum = 0;
      for (let offset = -yKernel.radius; offset <= yKernel.radius; offset += 1) {
        const yy = y + offset;
        if (yy >= 0 && yy < height) sum += horizontal[yy * width + x] * yKernel.kernel[offset + yKernel.radius];
      }
      output[y * width + x] = sum;
    }
  }
  return output;
}

export function plotBounds(points, kind) {
  const config = SETTINGS[kind];
  if (kind === "mwm") return { xmin: config.xRange[0], xmax: config.xRange[1], ymin: config.yRange[0], ymax: config.yRange[1] };
  const base = kdeBounds(points, kind);
  const dx = base.xmax - base.xmin; const dy = base.ymax - base.ymin;
  return { xmin: base.xmin - dx * 0.02, xmax: base.xmax + dx * 0.02, ymin: base.ymin - dy * 0.02, ymax: base.ymax + dy * 0.02 };
}

export function kdeBounds(points, kind) {
  const config = SETTINGS[kind];
  if (kind === "mwm") return { xmin: config.xRange[0], xmax: config.xRange[1], ymin: config.yRange[0], ymax: config.yRange[1] };
  const valid = points.filter((point) => point.valid);
  const xs = valid.map((point) => point.x); const ys = valid.map((point) => point.y);
  let xmin = Math.min(...xs); let xmax = Math.max(...xs); let ymin = Math.min(...ys); let ymax = Math.max(...ys);
  if (xmax === xmin) { xmin -= .5; xmax += .5; }
  if (ymax === ymin) { ymin -= .5; ymax += .5; }
  return { xmin, xmax, ymin, ymax };
}

function quantile(values, probability) {
  if (!values.length) return 1;
  values.sort((a, b) => a - b);
  const index = (values.length - 1) * probability;
  const lower = Math.floor(index); const upper = Math.ceil(index);
  return values[lower] + (values[upper] - values[lower]) * (index - lower);
}

export function createKde(points, kind, options = {}) {
  const bins = options.kdeResolution ?? SETTINGS.kdeResolution;
  const config = SETTINGS[kind];
  const fps = options.fps ?? SETTINGS.fps;
  const speedMax = options.speedMax ?? config.speedMax ?? SETTINGS.speedMax;
  const bandwidth = options.kdeBandwidth ?? config.kdeBandwidth;
  const excludeFastPoints = options.excludeFastPoints ?? false;
  const { xmin, xmax, ymin, ymax } = kdeBounds(points, kind);
  const counts = new Float32Array(bins * bins);
  let sampleCount = 0;
  for (let index = 0; index < points.length; index += 1) {
    const point = points[index];
    if (!point.valid) continue;
    if (excludeFastPoints && index > 0) {
      const previous = points[index - 1];
      if (previous.valid) {
        const speed = Math.hypot(point.x - previous.x, point.y - previous.y) * fps;
        if (speed > speedMax) continue;
      }
    }
    let x = Math.floor(((point.x - xmin) / (xmax - xmin)) * bins);
    let y = Math.floor(((point.y - ymin) / (ymax - ymin)) * bins);
    if (point.x === xmax) x = bins - 1;
    if (point.y === ymax) y = bins - 1;
    if (x >= 0 && x < bins && y >= 0 && y < bins) { counts[y * bins + x] += 1; sampleCount += 1; }
  }
  if (!sampleCount) throw new Error("没有可用于 KDE 的有效坐标点");
  const binWidth = (xmax - xmin) / bins; const binHeight = (ymax - ymin) / bins;
  // MASS::kde2d applies h / 4 internally. The binned convolution below is the
  // browser equivalent of its two-dimensional Gaussian KDE.
  const sigma = bandwidth / 4;
  const blurred = gaussianBlur(counts, bins, bins, sigma / binWidth, sigma / binHeight);
  const binArea = binWidth * binHeight;
  for (let i = 0; i < blurred.length; i += 1) blurred[i] /= sampleCount * binArea;
  if (kind === "mwm") {
    for (let y = 0; y < bins; y += 1) {
      const yValue = ymin + ((y + 0.5) / bins) * (ymax - ymin);
      for (let x = 0; x < bins; x += 1) {
        const xValue = xmin + ((x + 0.5) / bins) * (xmax - xmin);
        if (Math.hypot(xValue - config.cx, yValue - config.cy) > config.radius) {
          blurred[y * bins + x] = Number.NaN;
        }
      }
    }
  }
  const values = [...blurred].filter((value) => Number.isFinite(value));
  return { values: blurred, bins, bounds: { xmin, xmax, ymin, ymax }, upper: quantile(values, options.kdeQuantile ?? 0.98) };
}

export function safeStem(filename) {
  return filename.replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "sample";
}
