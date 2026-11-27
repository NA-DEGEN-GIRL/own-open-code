package dev.own.opencode.android;

import java.net.URI;
import java.net.URISyntaxException;

/**
 * Voice input's microphone in the PC WebView (02 §3.9, 08 §4.2): a page may capture audio only when the request comes
 * from the PC's app origin ({@code https://<pcKey>.ownpc.internal}) and asks for nothing but audio. Video, MIDI and
 * protected-media requests are always denied. No {@code android.*} here, so the JVM tests run it directly.
 */
final class MicPermission {
    /** {@code android.webkit.PermissionRequest.RESOURCE_AUDIO_CAPTURE}. */
    static final String AUDIO_CAPTURE = "android.webkit.resource.AUDIO_CAPTURE";

    private MicPermission() {}

    /** Whether a WebView permission request may get the microphone (the runtime permission is asked separately). */
    static boolean grantable(String origin, String appHost, String[] resources) {
        if (origin == null || appHost == null || resources == null || resources.length == 0) return false;
        for (String resource : resources) {
            if (!AUDIO_CAPTURE.equals(resource)) return false;
        }
        URI uri;
        try {
            uri = new URI(origin);
        } catch (URISyntaxException e) {
            return false;
        }
        return "https".equalsIgnoreCase(uri.getScheme())
                && appHost.equalsIgnoreCase(uri.getHost())
                && (uri.getPort() == -1 || uri.getPort() == 443)
                && uri.getUserInfo() == null;
    }
}
