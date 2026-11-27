package dev.own.opencode.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class SystemBarsTest {
    @Test
    public void readsWhatOwnWebsThemeAnswers() {
        // own-web src/host/app-bridge.ts `theme()`, as evaluateJavascript hands it over (the object's JSON).
        SystemBars.Look dark = SystemBars.parse("{\"scheme\":\"dark\",\"background\":\"rgb(23, 24, 26)\"}");
        assertEquals(0xFF17181A, dark.color);
        assertFalse(dark.lightPage);
        SystemBars.Look light = SystemBars.parse("{\"scheme\":\"light\",\"background\":\"rgb(255, 255, 255)\"}");
        assertEquals(0xFFFFFFFF, light.color);
        assertTrue(light.lightPage);
    }

    @Test
    public void noLookWithoutTheBridgeOrAColor() {
        // An older own-web (no window.ownApp) answers null; a page that is not own-web anything.
        assertNull(SystemBars.parse("null"));
        assertNull(SystemBars.parse(null));
        assertNull(SystemBars.parse("\"x\""));
        assertNull(SystemBars.parse("{\"scheme\":\"dark\"}"));
        assertNull(SystemBars.parse("{not json"));
        // A transparent background would paint the bars in nothing.
        assertNull(SystemBars.parse("{\"scheme\":\"dark\",\"background\":\"rgba(0, 0, 0, 0)\"}"));
    }

    @Test
    public void cssColors() {
        assertEquals(Integer.valueOf(0xFF0A0B0C), SystemBars.rgb("rgb(10, 11, 12)"));
        assertEquals(Integer.valueOf(0xFF0A0B0C), SystemBars.rgb("rgba(10, 11, 12, 1)"));
        assertNull(SystemBars.rgb("rgba(10, 11, 12, 0.5)"));
        assertNull(SystemBars.rgb("rgb(256, 0, 0)"));
        assertNull(SystemBars.rgb("#17181a"));
        assertNull(SystemBars.rgb("color(srgb 0.1 0.1 0.1)"));
    }
}
