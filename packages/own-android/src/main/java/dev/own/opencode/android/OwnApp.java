package dev.own.opencode.android;

import android.annotation.SuppressLint;
import android.app.Application;
import android.content.Context;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import androidx.webkit.ProxyConfig;
import androidx.webkit.ProxyController;
import androidx.webkit.WebViewFeature;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;

/**
 * Process-wide state: the paired PCs, the one {@link RouteProxy} every WebView and native request goes through
 * (08-app-access.md §3.4), and the routes of a pairing in progress (its PC is not stored yet).
 */
public final class OwnApp extends Application implements RouteProxy.Table {
    /** Appended to the WebView's user agent (08 §3.4 4); own-web skips its service worker for it. */
    static final String WEB_UA_SUFFIX = " OwnOpenCodeApp/1 (android)";

    interface WebProxyListener {
        /** True once WebView traffic goes through the route proxy; false when the proxy could not start. */
        void onWebProxy(boolean ready);
    }

    private PcStore store;
    private RouteProxy proxy;
    private Handler main;
    final ExecutorService io = Executors.newCachedThreadPool(runnable -> {
        Thread thread = new Thread(runnable, "own-io");
        thread.setDaemon(true);
        return thread;
    });
    private final Map<String, List<Route>> pendingRoutes = new ConcurrentHashMap<>();
    private final Map<String, Route> pendingLast = new ConcurrentHashMap<>();
    private final Set<String> removing = ConcurrentHashMap.newKeySet();
    private final Map<String, PairingSession> pairings = new ConcurrentHashMap<>();
    private boolean webProxyReady;
    private boolean webProxyApplying;
    private final List<WebProxyListener> webProxyWaiting = new ArrayList<>();

    static OwnApp of(Context context) {
        return (OwnApp) context.getApplicationContext();
    }

    @Override
    public void onCreate() {
        super.onCreate();
        store = new PcStore(this);
        proxy = new RouteProxy(this);
        main = new Handler(Looper.getMainLooper());
    }

    PcStore store() {
        return store;
    }

    /** User agent of native requests; the PC's SAS dialog and device list show it as "Own 앱 · Android". */
    static String nativeUserAgent() {
        return "OwnOpenCodeApp/1 (android) Android/" + Build.VERSION.RELEASE;
    }

    /** A pinned client for one PC through the route proxy (starts the proxy: not on the main thread). */
    PinnedHttps http(String pcKey, String pin) throws IOException {
        return new PinnedHttps(pcKey, pin, proxy.start(), nativeUserAgent());
    }

    boolean isRemoving(String pcKey) {
        return removing.contains(pcKey);
    }

    /**
     * Main thread. Removes a PC (08-app-access.md §3.6a): first revokes this device on the PC through the proxy with
     * the pin check (best effort, about {@link DeviceApi#REVOKE_TIMEOUT_MS}; an unreachable PC is simply skipped), then
     * clears the device cookie, the origin's web storage and the record. {@code done} runs on the main thread.
     */
    void removePc(PcRecord record, Runnable done) {
        removing.add(record.pcKey);
        AtomicBoolean finished = new AtomicBoolean();
        Runnable finish = () -> {
            if (!finished.compareAndSet(false, true)) return;
            PcRecord current = store.get(record.pcKey);
            // A new pairing of the same PC in the meantime keeps its cookie and record.
            if (current == null || current.deviceId.equals(record.deviceId)) {
                DeviceCookies.clear(record.pcKey);
                store.remove(record.pcKey);
            }
            removing.remove(record.pcKey);
            done.run();
        };
        String token = DeviceCookies.token(record.pcKey);
        if (token == null) {
            finish.run();
            return;
        }
        io.execute(() -> {
            try {
                DeviceApi.revoke(new PinnedHttps(record.pcKey, record.pin, proxy.start(), nativeUserAgent(),
                        DeviceApi.REVOKE_TIMEOUT_MS, DeviceApi.REVOKE_TIMEOUT_MS), token);
            } catch (IOException ignored) {
                // The proxy could not start: remove locally anyway.
            }
            main.post(finish);
        });
        // A hard bound for the list even when several slow route attempts add up.
        main.postDelayed(finish, DeviceApi.REVOKE_TIMEOUT_MS + 1000);
    }

    /**
     * Main thread. Starts pairing with {@code link} (08 §3.5) and returns its id, which the activity keeps in its saved
     * state: the pairing lives here, so it survives the activity being recreated or off screen. It is memory only (the
     * claim secret never reaches disk), so after the process ends {@link #pairing} finds nothing.
     */
    String startPairing(PairingLink link) {
        beginPairing(link);
        String id = UUID.randomUUID().toString();
        PairingSession session = new PairingSession(link.code, new PairingSession.Host() {
            @Override
            public PinnedHttps http() throws IOException {
                return OwnApp.this.http(link.pcKey, link.pin);
            }

            @Override
            public void save(PairingFlow.Result result, Consumer<Boolean> done) {
                main.post(() -> {
                    Route last = endPairing(link.pcKey);
                    DeviceCookies.set(link.pcKey, result.token, result.expiresAt, ok -> {
                        if (ok) {
                            store.put(new PcRecord(link.pcKey, link.name, link.pin, link.routes, last, result.deviceId,
                                    result.expiresAt, System.currentTimeMillis()));
                        }
                        done.accept(ok);
                    });
                });
            }

            @Override
            public void end() {
                endPairing(link.pcKey);
            }
        }, PairingFlow.Timing.DEFAULT);
        pairings.put(id, session);
        session.start(io);
        return id;
    }

    /** The pairing {@link #startPairing} returned {@code id} for, or null (unknown, or the process was restarted). */
    PairingSession pairing(String id) {
        return id == null ? null : pairings.get(id);
    }

    /** The activity is done with a pairing: one still running is cancelled. */
    void dropPairing(String id) {
        PairingSession session = pairings.remove(id);
        if (session != null) session.cancel();
    }

    /** Makes the proxy route {@code link}'s PC by the link's routes until {@link #endPairing}. */
    void beginPairing(PairingLink link) {
        pendingLast.remove(link.pcKey);
        pendingRoutes.put(link.pcKey, link.routes);
    }

    /** Ends a pairing's routing; returns the route that connected during it, or null. */
    Route endPairing(String pcKey) {
        pendingRoutes.remove(pcKey);
        return pendingLast.remove(pcKey);
    }

    @Override
    public List<Route> routes(String pcKey) {
        List<Route> pending = pendingRoutes.get(pcKey);
        if (pending != null) return pending;
        PcRecord record = store.get(pcKey);
        return record == null ? null : record.routes;
    }

    @Override
    public Route lastRoute(String pcKey) {
        if (pendingRoutes.containsKey(pcKey)) return pendingLast.get(pcKey);
        PcRecord record = store.get(pcKey);
        return record == null ? null : record.lastRoute;
    }

    @Override
    public void connected(String pcKey, Route route) {
        if (pendingRoutes.containsKey(pcKey)) pendingLast.put(pcKey, route);
        else store.connected(pcKey, route);
    }

    /**
     * Main thread. Points all WebView traffic of this process at the route proxy (once), then calls {@code listener}.
     * The caller checks {@code WebViewFeature.PROXY_OVERRIDE} first to explain an old WebView.
     */
    @SuppressLint("RequiresFeature") // checked at the top; lint does not follow it into the posted lambda
    void withWebProxy(WebProxyListener listener) {
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.PROXY_OVERRIDE)) {
            listener.onWebProxy(false);
            return;
        }
        if (webProxyReady) {
            listener.onWebProxy(true);
            return;
        }
        webProxyWaiting.add(listener);
        if (webProxyApplying) return;
        webProxyApplying = true;
        io.execute(() -> {
            int port;
            try {
                port = proxy.start();
            } catch (IOException e) {
                main.post(() -> webProxyDone(false));
                return;
            }
            main.post(() -> {
                // One rule for every scheme and host: the proxy refuses anything that is not a known app host, so a
                // page cannot reach the internet or the LAN directly (no implicit DIRECT fallback either).
                // removeImplicitRules: localhost and loopback addresses go through the proxy too (and get 403), so a
                // page cannot reach services on this phone either.
                ProxyConfig config = new ProxyConfig.Builder()
                        .addProxyRule("127.0.0.1:" + port)
                        .removeImplicitRules()
                        .build();
                ProxyController.getInstance().setProxyOverride(config, getMainExecutor(), () -> webProxyDone(true));
            });
        });
    }

    private void webProxyDone(boolean ready) {
        webProxyApplying = false;
        webProxyReady = ready;
        List<WebProxyListener> waiting = new ArrayList<>(webProxyWaiting);
        webProxyWaiting.clear();
        for (WebProxyListener listener : waiting) listener.onWebProxy(ready);
    }
}
