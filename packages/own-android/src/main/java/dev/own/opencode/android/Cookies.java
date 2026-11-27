package dev.own.opencode.android;

/**
 * The device cookie (08-app-access.md §3.5): {@code own_device=<token>} on {@code https://<pcKey>.ownpc.internal},
 * {@code Path=/; Secure; HttpOnly; SameSite=Strict}, living until the token's expiry. The token exists nowhere else in
 * the app: it is read back from the cookie store only for {@code /own/routes}.
 */
final class Cookies {
    static final String DEVICE = "own_device";

    private Cookies() {}

    /** The Set-Cookie value for a fresh device token. */
    static String device(String token, long maxAgeSeconds) {
        return DEVICE + "=" + token + "; Path=/; Max-Age=" + Math.max(0, maxAgeSeconds) + "; Secure; HttpOnly; SameSite=Strict";
    }

    /** The Set-Cookie value that removes the device cookie. */
    static String expiredDevice() {
        return DEVICE + "=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict";
    }

    /** Seconds from {@code nowMs} until {@code expiresAtMs}, at least 0. */
    static long maxAge(long expiresAtMs, long nowMs) {
        return Math.max(0, (expiresAtMs - nowMs) / 1000);
    }

    /** The value of cookie {@code name} in a {@code Cookie:}-style string ({@code a=1; b=2}), or null. */
    static String find(String cookies, String name) {
        if (cookies == null) return null;
        for (String part : cookies.split(";")) {
            String pair = part.trim();
            int eq = pair.indexOf('=');
            if (eq > 0 && pair.substring(0, eq).trim().equals(name)) {
                String value = pair.substring(eq + 1).trim();
                return value.isEmpty() ? null : value;
            }
        }
        return null;
    }
}
