export const SETTINGS = {
  fps: 20,
  speedMax: 120,
  bins: 180,
  mwm: {
    cx: 265,
    cy: 270,
    radius: 268,
    xRange: [-3, 533],
    yRange: [2, 538],
    smoothUnits: 12,
    speedMax: 120,
  },
  of: {
    xRange: [0, 200],
    yRange: [0, 200],
    smoothUnits: 15,
    speedMax: 200,
  },
};

const PAIR_RE = /(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)/g;

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
  const matches = [...text.matchAll(PAIR_RE)];
  let raw = matches.map((match) => [Number(match[1]), Number(match[2])]);
  if (raw.length < 100) raw = parseStandardXY(text);
  if (raw.length < 100) {
    throw new Error("未检测到逐帧 x,y 坐标；可能是汇总表或事件表");
  }
  return raw.map(([x, y]) => ({
    x,
    y,
    valid: Number.isFinite(x) && Number.isFinite(y) && x >= 0 && y >= 0,
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

function gaussianBlur(source, bins, sigma) {
  const { kernel, radius } = gaussianKernel(sigma);
  const horizontal = new Float32Array(source.length);
  const output = new Float32Array(source.length);
  for (let y = 0; y < bins; y += 1) {
    for (let x = 0; x < bins; x += 1) {
      let sum = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const xx = x + offset;
        if (xx >= 0 && xx < bins) sum += source[y * bins + xx] * kernel[offset + radius];
      }
      horizontal[y * bins + x] = sum;
    }
  }
  for (let y = 0; y < bins; y += 1) {
    for (let x = 0; x < bins; x += 1) {
      let sum = 0;
      for (let offset = -radius; offset <= radius; offset += 1) {
        const yy = y + offset;
        if (yy >= 0 && yy < bins) sum += horizontal[yy * bins + x] * kernel[offset + radius];
      }
      output[y * bins + x] = sum;
    }
  }
  return output;
}

export function createOccupancy(points, kind, options = {}) {
  const bins = SETTINGS.bins;
  const config = SETTINGS[kind];
  const fps = options.fps ?? SETTINGS.fps;
  const speedMax = options.speedMax ?? config.speedMax ?? SETTINGS.speedMax;
  const smoothUnits = options.smoothUnits ?? config.smoothUnits;
  const excludeFastPoints = options.excludeFastPoints ?? false;
  const [xmin, xmax] = config.xRange;
  const [ymin, ymax] = config.yRange;
  const counts = new Float32Array(bins * bins);
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
    if (x >= 0 && x < bins && y >= 0 && y < bins) counts[y * bins + x] += 1 / fps;
  }
  const binSize = (xmax - xmin) / bins;
  const blurred = gaussianBlur(counts, bins, smoothUnits / binSize);
  const binArea = ((xmax - xmin) / bins) * ((ymax - ymin) / bins);
  for (let i = 0; i < blurred.length; i += 1) blurred[i] /= binArea;
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
  return blurred;
}

export function sharedHeatMaximum(occupancies, manualMaximum = null) {
  if (Number.isFinite(manualMaximum) && manualMaximum > 0) return manualMaximum;
  const values = [];
  for (const occupancy of occupancies) {
    for (const value of occupancy) {
      if (Number.isFinite(value) && value > 0) values.push(value);
    }
  }
  if (!values.length) return 1;
  values.sort((a, b) => a - b);
  return values[Math.min(values.length - 1, Math.floor(values.length * 0.995))];
}

export function safeStem(filename) {
  return filename.replace(/\.[^.]+$/, "").replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "sample";
}
