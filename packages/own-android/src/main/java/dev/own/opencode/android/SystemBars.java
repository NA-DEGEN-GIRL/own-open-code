package dev.own.opencode.android;

import org.json.JSONException;
import org.json.JSONObject;

/**
 * The status and navigation bars follow the PC page's theme (MUX 2026-11-06): own-web answers
 * {@code window.ownApp.theme()} ({@code {"scheme":"light"|"dark","background":"rgb(r, g, b)"}}, src/host/app-bridge.ts),
 * which the PC screen reads with {@code evaluateJavascript} after a page load, a route change and a resume. Plain Java
 * (no {@code android.*}), so the JVM tests parse it directly.
 */
final class SystemBars {
    /** The bars' background (opaque ARGB) and whether their icons are dark (a light page). */
    static final class Look {
        final int color;
        final boolean lightPage;

        Look(int color, boolean lightPage) {
            this.color = color;
            this.lightPage = lightPage;
        }
    }

    private SystemBars() {}

    /**
     * The look in an {@code evaluateJavascript} result: the JSON of {@code theme()}'s object, or {@code null}/anything
     * else (an older own-web without the bridge, a page that is not own-web) for none.
     */
    static Look parse(String result) {
        if (result == null || !result.startsWith("{")) return null;
        try {
            JSONObject theme = new JSONObject(result);
            Integer color = rgb(theme.optString("background", ""));
            if (color == null) return null;
            return new Look(color, "light".equals(theme.optString("scheme", "")));
        } catch (JSONException e) {
            return null;
        }
    }

    /** {@code rgb(r, g, b)} or {@code rgba(r, g, b, a)} as CSS computes it; a transparent background is no color. */
    static Integer rgb(String css) {
        java.util.regex.Matcher match = java.util.regex.Pattern
                .compile("^rgba?\\(\\s*(\\d{1,3})\\s*,\\s*(\\d{1,3})\\s*,\\s*(\\d{1,3})\\s*(?:,\\s*([0-9.]+)\\s*)?\\)$")
                .matcher(css.trim());
        if (!match.matches()) return null;
        if (match.group(4) != null && Double.parseDouble(match.group(4)) < 1) return null;
        int r = Integer.parseInt(match.group(1));
        int g = Integer.parseInt(match.group(2));
        int b = Integer.parseInt(match.group(3));
        if (r > 255 || g > 255 || b > 255) return null;
        return 0xFF000000 | (r << 16) | (g << 8) | b;
    }
}
