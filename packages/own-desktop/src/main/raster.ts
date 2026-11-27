// Chromium raster switches (05 §9.2 R-D13), apart from own-shell.ts so tests need no Electron.
import { envSnapshot } from "./own-env"

/**
 * Chromium switches for PF1 (05 §9.2 R-D13): raster on the renderer's CPU raster threads, compositing on the GPU.
 * Electron 44 keeps no Skia shader cache between launches (no GrShaderCache under userData), so with GPU raster
 * every launch compiles the first frame's shaders (D3DCompile, ~250–300 ms on this PC) before anything reaches the
 * screen: first contentful paint p95 1,150 ms → 900 ms after the spawn. Four raster threads keep fast scrolling
 * close to GPU raster (PF3 in the shell, 4,000 px/s fling at 240 Hz: 0.5 % dropped frames, 4 of 2,400 frames
 * checkerboarded, against 0 / 0 with GPU raster and 5.8 % / 21 with Chromium's default thread count).
 * `OWN_DESKTOP_GPU_RASTER=1` keeps Chromium's default (GPU raster) for comparison.
 */
export function rasterSwitches(env: Readonly<Record<string, string | undefined>> = envSnapshot): [string, string?][] {
  if (env.OWN_DESKTOP_GPU_RASTER === "1") return []
  return [["disable-gpu-rasterization"], ["num-raster-threads", "4"]]
}
