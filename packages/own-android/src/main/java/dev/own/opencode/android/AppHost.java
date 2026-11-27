package dev.own.opencode.android;

import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The app-side names of a PC (08-app-access.md §3.1): {@code <pcKey>.ownpc.internal} exists in no DNS. Pages and native
 * requests use it; the local {@link RouteProxy} maps it to the PC's routes.
 */
final class AppHost {
    static final String SUFFIX = ".ownpc.internal";
    static final Pattern PC_KEY = Pattern.compile("[a-z2-7]{12}");

    private AppHost() {}

    static boolean isPcKey(String value) {
        return value != null && PC_KEY.matcher(value).matches();
    }

    /** {@code <pcKey>.ownpc.internal}. */
    static String host(String pcKey) {
        return pcKey + SUFFIX;
    }

    /** {@code https://<pcKey>.ownpc.internal} (port 443 implied). */
    static String origin(String pcKey) {
        return "https://" + host(pcKey);
    }

    /** The pcKey of an app host name, or null when {@code host} is not one. */
    static String pcKeyOf(String host) {
        if (host == null) return null;
        String lower = host.toLowerCase(Locale.ROOT);
        if (!lower.endsWith(SUFFIX)) return null;
        String key = lower.substring(0, lower.length() - SUFFIX.length());
        return isPcKey(key) ? key : null;
    }
}
