# 行为轨迹 PDF 工作台

批量上传 MWM 水迷宫或 OF 旷场逐帧坐标 CSV，在浏览器中生成 track plot 和空间占用热图 PDF，并下载 ZIP。

## 本地运行

```bash
pnpm install
pnpm build
```

然后用任意静态文件服务器打开 `dist/`。

## 发布到 GitHub Pages

仓库推送到 `main` 后，GitHub Actions 会自动构建 `dist/` 并部署到 GitHub Pages。首次发布前，在仓库设置的 Pages 页面将 Build and deployment source 设为 GitHub Actions。

CSV 解析、绘图和 PDF/ZIP 打包都在访问者的浏览器中执行，原始 CSV 不会上传。
