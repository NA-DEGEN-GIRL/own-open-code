package dev.own.opencode.android;

import android.webkit.CookieManager;
import android.webkit.ValueCallback;
import android.webkit.WebStorage;

/** The device cookie in the WebView cookie store (08-app-access.md §3.5). Call on the main thread. */
final class DeviceCookies {
    private DeviceCookies() {}

    /** Sets {@code own_device=<token>} on the PC's app origin and flushes it to disk; {@code done} gets success. */
    static void set(String pcKey, String token, long expiresAt, ValueCallback<Boolean> done) {
        CookieManager cookies = CookieManager.getInstance();
        cookies.setAcceptCookie(true);
        cookies.setCookie(AppHost.origin(pcKey) + "/", Cookies.device(token, Cookies.maxAge(expiresAt, System.currentTimeMillis())),
                ok -> {
                    cookies.flush();
                    done.onReceiveValue(Boolean.TRUE.equals(ok));
                });
    }

    /** The device token, read back for {@code Authorization: Bearer} (route refresh), or null. */
    static String token(String pcKey) {
        return Cookies.find(CookieManager.getInstance().getCookie(AppHost.origin(pcKey) + "/"), Cookies.DEVICE);
    }

    /** Removes the device cookie and the origin's web storage (localStorage, IndexedDB, caches). */
    static void clear(String pcKey) {
        CookieManager cookies = CookieManager.getInstance();
        cookies.setCookie(AppHost.origin(pcKey) + "/", Cookies.expiredDevice(), ok -> cookies.flush());
        WebStorage.getInstance().deleteOrigin(AppHost.origin(pcKey));
    }
}
