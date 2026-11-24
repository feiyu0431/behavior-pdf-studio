import JSZip from "jszip";
import { jsPDF } from "jspdf";
import {
  SETTINGS,
  createOccupancy,
  createSpeedSegments,
  parseCoordinateBuffer,
  safeStem,
  sharedHeatMaximum,
  transformPoints,
} from "./core.js";

const $ = (selector) => document.querySelector(selector);
const state = { kind: "mwm", files: [], parsed: [], outputs: [], zipBlob: null, objectUrls: [] };
const speedPalette = ["#08306B", "#4292C6", "#FEE090", "#D73027"];
const heatPalette = ["#0B2A6B", "#145DA0", "#1FA3D7", "#39D353", "#F6F926", "#FCA311", "#D62828"];

function hexRgb(hex) {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}

function interpolatePalette(palette, value) {
  const clamped = Math.max(0, Math.min(1, value));
  const scaled = clamped * (palette.length - 1);
  const index = Math.min(palette.length - 2, Math.floor(scaled));
  const fraction = scaled - index;
  const a = hexRgb(palette[index]);
  const b = hexRgb(palette[index + 1]);
  return a.map((channel, i) => Math.round(channel + (b[i] - channel) * fraction));
}

function numericInput(selector, label, minimum, fallback = null) {
  const raw = $(selector).value.trim();
  if (!raw && fallback !== null) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < minimum) throw new Error(`${label}必须不小于 ${minimum}`);
  return value;
}

function optionalPositiveInput(selector, label) {
  const raw = $(selector).value.trim();
  if (!raw) return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label}必须大于 0，或留空使用自动范围`);
  return value;
}

function currentPlotOptions() {
  return {
    fps: numericInput("#fps", "帧率", 1),
    speedMax: numericInput("#speed-max", "速度上限", 1),
    lineWidth: numericInput("#line-width", "轨迹线宽", 0.2),
    smoothUnits: numericInput("#heat-smoothing", "热图平滑半径", 1),
    heatMax: optionalPositiveInput("#heat-max", "热图色标上限"),
    excludeFastPoints: $("#exclude-fast-points").checked,
  };
}

function densityFormat(value) {
  if (value === 0) return "0";
  if (Math.abs(value) >= 0.01 && Math.abs(value) < 100) return Number(value.toPrecision(3)).toString();
  return value.toExponential(2).replace("e-", "e−");
}

function setupCanvas() {
  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = 1500;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "white";
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  return { canvas, ctx };
}

function geometry(kind) {
  const config = SETTINGS[kind];
  return { left: 95, top: 150, size: 1180, xmin: config.xRange[0], xmax: config.xRange[1], ymin: config.yRange[0], ymax: config.yRange[1] };
}

function projector(kind) {
  const g = geometry(kind);
  return {
    ...g,
    x: (value) => g.left + ((value - g.xmin) / (g.xmax - g.xmin)) * g.size,
    y: (value) => g.top + (1 - (value - g.ymin) / (g.ymax - g.ymin)) * g.size,
  };
}

function drawTitle(ctx, title) {
  ctx.fillStyle = "#111827";
  ctx.font = "600 40px Arial, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText(title, 800, 72);
}

function drawArena(ctx, kind) {
  const p = projector(kind);
  ctx.save();
  ctx.strokeStyle = "#111827";
  ctx.lineWidth = 4;
  if (kind === "mwm") {
    const cfg = SETTINGS.mwm;
    const cx = p.x(cfg.cx);
    const cy = p.y(cfg.cy);
    const radius = (cfg.radius / (p.xmax - p.xmin)) * p.size;
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
    ctx.setLineDash([5, 6]); ctx.globalAlpha = 0.42; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(cx, p.top); ctx.lineTo(cx, p.top + p.size); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(p.left, cy); ctx.lineTo(p.left + p.size, cy); ctx.stroke();
    ctx.setLineDash([]); ctx.globalAlpha = 1; ctx.lineWidth = 4;
    const angle = (-29.5 * Math.PI) / 180;
    const platformX = cfg.cx + cfg.radius * 0.48 * Math.cos(angle);
    const platformY = cfg.cy + cfg.radius * 0.48 * Math.sin(angle);
    ctx.beginPath(); ctx.arc(p.x(platformX), p.y(platformY), (cfg.radius * 0.09 / (p.xmax - p.xmin)) * p.size, 0, Math.PI * 2); ctx.stroke();
  } else {
    ctx.strokeRect(p.left, p.top, p.size, p.size);
    ctx.setLineDash([10, 8]); ctx.lineWidth = 3;
    ctx.strokeRect(p.x(40), p.y(160), p.x(160) - p.x(40), p.y(40) - p.y(160));
  }
  ctx.restore();
}

function drawColorbar(ctx, palette, label, ticks, formatter) {
  const x = 1342, y = 205, width = 48, height = 980;
  const gradient = ctx.createLinearGradient(0, y + height, 0, y);
  palette.forEach((color, index) => gradient.addColorStop(index / (palette.length - 1), color));
  ctx.fillStyle = gradient; ctx.fillRect(x, y, width, height);
  ctx.strokeStyle = "#17212b"; ctx.lineWidth = 3; ctx.strokeRect(x, y, width, height);
  ctx.fillStyle = "#17212b"; ctx.font = "26px Arial, sans-serif"; ctx.textAlign = "left";
  for (const tick of ticks) {
    const yy = y + height - tick.position * height;
    ctx.beginPath(); ctx.moveTo(x + width, yy); ctx.lineTo(x + width + 13, yy); ctx.stroke();
    ctx.fillText(formatter(tick.value), x + width + 22, yy + 9);
  }
  ctx.save(); ctx.translate(1515, y + height / 2); ctx.rotate(-Math.PI / 2); ctx.textAlign = "center"; ctx.font = "28px Arial, sans-serif"; ctx.fillText(label, 0, 0); ctx.restore();
}

function drawTrack(points, kind, name, options) {
  const { canvas, ctx } = setupCanvas();
  const p = projector(kind);
  drawTitle(ctx, `${kind === "mwm" ? "Morris water maze" : "Open field test"} – ${name}`);
  ctx.save();
  if (kind === "mwm") {
    const cfg = SETTINGS.mwm; const cx = p.x(cfg.cx); const cy = p.y(cfg.cy); const radius = (cfg.radius / (p.xmax - p.xmin)) * p.size;
    ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.clip();
  } else { ctx.beginPath(); ctx.rect(p.left, p.top, p.size, p.size); ctx.clip(); }
  ctx.lineWidth = 2.2 * options.lineWidth;
  for (const segment of createSpeedSegments(points, options.fps)) {
    const [r, g, b] = interpolatePalette(speedPalette, segment.speed / options.speedMax);
    ctx.strokeStyle = `rgb(${r},${g},${b})`;
    ctx.beginPath(); ctx.moveTo(p.x(segment.x1), p.y(segment.y1)); ctx.lineTo(p.x(segment.x2), p.y(segment.y2)); ctx.stroke();
  }
  ctx.restore();
  drawArena(ctx, kind);
  drawColorbar(ctx, speedPalette, "Speed (px/s)", [0, .25, .5, .75, 1].map((position) => ({ value: position * options.speedMax, position })), (value) => densityFormat(value));
  return canvas;
}

function drawHeatmap(occupancy, sharedMaximum, kind, name) {
  const { canvas, ctx } = setupCanvas();
  const p = projector(kind);
  drawTitle(ctx, `${kind === "mwm" ? "Morris water maze heatmap" : "Open field heatmap"} – ${name}`);
  const bins = SETTINGS.bins;
  const heatCanvas = document.createElement("canvas"); heatCanvas.width = bins; heatCanvas.height = bins;
  const heatCtx = heatCanvas.getContext("2d"); const image = heatCtx.createImageData(bins, bins);
  for (let y = 0; y < bins; y += 1) {
    for (let x = 0; x < bins; x += 1) {
      const sourceIndex = y * bins + x;
      const targetIndex = ((bins - 1 - y) * bins + x) * 4;
      const value = occupancy[sourceIndex];
      if (!Number.isFinite(value)) { image.data[targetIndex + 3] = 0; continue; }
      const [r, g, b] = interpolatePalette(heatPalette, Math.min(1, value / sharedMaximum));
      image.data[targetIndex] = r; image.data[targetIndex + 1] = g; image.data[targetIndex + 2] = b; image.data[targetIndex + 3] = 255;
    }
  }
  heatCtx.putImageData(image, 0, 0);
  ctx.imageSmoothingEnabled = true; ctx.imageSmoothingQuality = "high";
  ctx.drawImage(heatCanvas, p.left, p.top, p.size, p.size);
  drawArena(ctx, kind);
  drawColorbar(ctx, heatPalette, "Dwell density (s/px²)", [0, .25, .5, .75, 1].map((position) => ({ value: position * sharedMaximum, position })), densityFormat);
  return canvas;
}

function canvasToPdf(canvas) {
  const pdf = new jsPDF({ orientation: "landscape", unit: "mm", format: [160, 150], compress: true });
  pdf.addImage(canvas.toDataURL("image/jpeg", 0.96), "JPEG", 0, 0, 160, 150, undefined, "FAST");
  return pdf.output("blob");
}

function setProgress(done, total, message) {
  const percent = total ? Math.round((done / total) * 100) : 0;
  $("#progress-wrap").hidden = false;
  $("#progress-bar").style.width = `${percent}%`;
  $("#progress-text").textContent = `${percent}%`;
  $("#status").textContent = message;
}

function nextPaint() { return new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))); }

function releaseUrls() { for (const url of state.objectUrls) URL.revokeObjectURL(url); state.objectUrls = []; }

async function loadFiles(files) {
  releaseUrls(); state.outputs = []; state.zipBlob = null; $("#results").hidden = true;
  state.files = [...files].filter((file) => file.name.toLowerCase().endsWith(".csv"));
  state.parsed = [];
  $("#file-panel").hidden = state.files.length === 0;
  $("#file-count").textContent = `${state.files.length} 个文件`;
  $("#file-list").innerHTML = "";
  for (const file of state.files) {
    const item = document.createElement("li"); item.innerHTML = `<span>${file.name}</span><em>解析中</em>`; $("#file-list").append(item);
    try {
      const raw = parseCoordinateBuffer(await file.arrayBuffer());
      const points = transformPoints(raw, state.kind);
      const valid = points.filter((point) => point.valid).length;
      state.parsed.push({ file, name: safeStem(file.name), points, item });
      item.querySelector("em").textContent = `${valid.toLocaleString()} 个有效点`;
    } catch (error) {
      item.classList.add("error"); item.querySelector("em").textContent = error.message;
    }
  }
  $("#valid-count").textContent = `${state.parsed.length} 个可处理`;
  $("#generate").disabled = state.parsed.length === 0;
  $("#status").textContent = state.parsed.length ? `已识别 ${state.parsed.length} 个坐标文件。` : "未识别到逐帧坐标，请检查 CSV 类型。";
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob); const link = document.createElement("a"); link.href = url; link.download = filename; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function generateAll() {
  $("#generate").disabled = true; $("#download-zip").disabled = true; releaseUrls(); state.outputs = [];
  try {
    const options = currentPlotOptions();
    setProgress(0, state.parsed.length * 3, "正在计算停留时间密度…");
    const occupancies = [];
    for (let i = 0; i < state.parsed.length; i += 1) {
      occupancies.push(createOccupancy(state.parsed[i].points, state.kind, options));
      setProgress(i + 1, state.parsed.length * 3, `正在计算热图 ${i + 1}/${state.parsed.length}`); await nextPaint();
    }
    const maximum = sharedHeatMaximum(occupancies, options.heatMax); const zip = new JSZip();
    for (let i = 0; i < state.parsed.length; i += 1) {
      const sample = state.parsed[i];
      const trackCanvas = drawTrack(sample.points, state.kind, sample.name, options); const trackBlob = canvasToPdf(trackCanvas);
      state.outputs.push({ name: `${sample.name}_track.pdf`, folder: "track_plot", blob: trackBlob, preview: trackCanvas.toDataURL("image/jpeg", .72) });
      zip.file(`track_plot/${sample.name}_track.pdf`, trackBlob);
      setProgress(state.parsed.length + i + 1, state.parsed.length * 3, `正在生成轨迹 PDF ${i + 1}/${state.parsed.length}`); await nextPaint();
      const heatCanvas = drawHeatmap(occupancies[i], maximum, state.kind, sample.name); const heatBlob = canvasToPdf(heatCanvas);
      state.outputs.push({ name: `${sample.name}_heatmap.pdf`, folder: "heatmap", blob: heatBlob, preview: heatCanvas.toDataURL("image/jpeg", .72) });
      zip.file(`heatmap/${sample.name}_heatmap.pdf`, heatBlob);
      setProgress(state.parsed.length * 2 + i + 1, state.parsed.length * 3, `正在生成热图 PDF ${i + 1}/${state.parsed.length}`); await nextPaint();
    }
    state.zipBlob = await zip.generateAsync({ type: "blob", compression: "DEFLATE", compressionOptions: { level: 6 } });
    renderResults(); setProgress(state.parsed.length * 3, state.parsed.length * 3, `完成：${state.outputs.length} 份 PDF。`);
  } catch (error) { $("#status").textContent = `生成失败：${error.message}`; console.error(error); }
  finally { $("#generate").disabled = state.parsed.length === 0; $("#download-zip").disabled = !state.zipBlob; }
}

function renderResults() {
  $("#results").hidden = false; const previews = $("#preview-grid"); const list = $("#download-list"); previews.innerHTML = ""; list.innerHTML = "";
  const firstTrack = state.outputs.find((output) => output.folder === "track_plot"); const firstHeat = state.outputs.find((output) => output.folder === "heatmap");
  for (const output of [firstTrack, firstHeat].filter(Boolean)) {
    const card = document.createElement("article"); card.className = "preview-card"; card.innerHTML = `<img src="${output.preview}" alt="${output.name} 预览"><div><strong>${output.folder === "track_plot" ? "Track plot" : "Heatmap"}</strong><span>${output.name}</span></div>`; previews.append(card);
  }
  for (const output of state.outputs) {
    const row = document.createElement("div"); row.className = "download-item"; row.innerHTML = `<span>${output.folder}/${output.name}</span><button type="button">下载</button>`; row.querySelector("button").addEventListener("click", () => downloadBlob(output.blob, output.name)); list.append(row);
  }
  $("#results").scrollIntoView({ behavior: "smooth", block: "start" });
}

document.querySelectorAll(".experiment").forEach((button) => button.addEventListener("click", async () => {
  document.querySelectorAll(".experiment").forEach((item) => item.classList.toggle("active", item === button)); state.kind = button.dataset.kind;
  $("#speed-max").value = SETTINGS[state.kind].speedMax;
  $("#heat-smoothing").value = SETTINGS[state.kind].smoothUnits;
  $("#heat-max").value = "";
  $("#format-note").textContent = state.kind === "mwm" ? "MWM：支持原始 “x,y” 坐标流及标准 x、y 列 CSV；负坐标按追踪丢失处理。" : "OF：请上传逐帧 x,y 坐标文件；统计汇总、事件与其他行为表会被自动拒绝。";
  if (state.files.length) await loadFiles(state.files);
}));

const dropzone = $("#dropzone");
dropzone.addEventListener("dragover", (event) => { event.preventDefault(); dropzone.classList.add("dragging"); });
dropzone.addEventListener("dragleave", () => dropzone.classList.remove("dragging"));
dropzone.addEventListener("drop", (event) => { event.preventDefault(); dropzone.classList.remove("dragging"); loadFiles(event.dataTransfer.files); });
$("#file-input").addEventListener("change", (event) => loadFiles(event.target.files));
$("#clear-files").addEventListener("click", () => { state.files = []; state.parsed = []; $("#file-input").value = ""; $("#file-panel").hidden = true; $("#generate").disabled = true; $("#results").hidden = true; $("#progress-wrap").hidden = true; $("#status").textContent = "请选择实验类型并上传坐标 CSV。"; releaseUrls(); });
$("#generate").addEventListener("click", generateAll);
$("#download-zip").addEventListener("click", () => state.zipBlob && downloadBlob(state.zipBlob, `${state.kind.toUpperCase()}_plots_PDF.zip`));
