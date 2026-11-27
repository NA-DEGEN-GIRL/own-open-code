package dev.own.opencode.android;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import java.util.regex.Pattern;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Native pairing over the app listener (08-app-access.md §3.5, 05 §13.5):
 *
 * <ol>
 *   <li>{@code GET /auth/connect/<code>} with {@code Accept: application/json} → {@code {claim, sas, name, expiresAt}}
 *       (410 expired or used, 429 rate limited);
 *   <li>show the SAS; poll {@code GET /own/pairing} with {@code x-own-pairing: <claim>} every second → {@code {state}};
 *   <li>on {@code approved}: {@code POST /own/pairing/claim} (same header, body {@code {}}) →
 *       {@code {deviceId, token, expiresAt}}.
 * </ol>
 *
 * Runs on a background thread; {@link #abort()} stops it from any thread. The claim secret and the token never leave
 * this object except in the {@link Result}.
 *
 * <p>While the PC waits for its user, the phone may leave the app (to press 허용 through a remote-desktop app on the
 * same phone). Android then cuts a background app's network under data saver or a background-data restriction, so
 * {@link #hold()} stops polling while the app is off screen and {@link #release()} polls again at once. A request that
 * fails on the network is retried until the gateway's window for that step has passed (2 minutes to approve, 2 to
 * claim, {@link Timing}); one that fails while held does not count.
 */
final class PairingFlow {
    /** Consecutive network failures after which the listener hears that the PC is not answering (still retrying). */
    static final int HINT_AFTER_FAILURES = 3;

    /** How often to poll and how long each step may take: the gateway's windows plus a little for slow answers. */
    static final class Timing {
        static final Timing DEFAULT = new Timing(1000, 2 * 60 * 1000 + 15_000, 2 * 60 * 1000 + 15_000, 5 * 60 * 1000);

        final long pollMs;
        /** From the start until the PC approves (gateway: 2 minutes from the link's opening). */
        final long approvalMs;
        /** From the approval until the claim (gateway: 2 minutes). */
        final long claimMs;
        /** Local backstop for the whole flow, however long the app was held. */
        final long maxWaitMs;

        Timing(long pollMs, long approvalMs, long claimMs, long maxWaitMs) {
            this.pollMs = pollMs;
            this.approvalMs = approvalMs;
            this.claimMs = claimMs;
            this.maxWaitMs = maxWaitMs;
        }
    }

    private static final Pattern CLAIM = Pattern.compile("[A-Za-z0-9_-]{20,128}");
    private static final Pattern SAS = Pattern.compile("[0-9]{4}");
    private static final Pattern TOKEN = Pattern.compile("[A-Za-z0-9_-]{40,64}");
    private static final Pattern DEVICE_ID = Pattern.compile("[A-Za-z0-9_.:-]{1,128}");

    enum Failure {
        /** The link was used or expired, or the pairing timed out (410, {@code expired}, unknown). */
        EXPIRED,
        /** The PC rejected the request (or the SAS did not match). */
        REJECTED,
        /** The PC cancelled the pairing. */
        CANCELLED,
        RATE_LIMITED,
        /** No route reached the PC when the link was opened. */
        UNREACHABLE,
        /** The PC stopped answering while the pairing waited, until the step's window passed. */
        CONNECTION_LOST,
        /** The PC's certificate does not have the link's pin. */
        PIN_MISMATCH,
        /** An answer the app does not understand (older gateway, browser pairing refused, ...). */
        PROTOCOL,
        /** {@link #abort()} was called. */
        ABORTED
    }

    static final class Failed extends Exception {
        final Failure failure;

        Failed(Failure failure) {
            super(failure.name());
            this.failure = failure;
        }
    }

    interface Listener {
        /** The SAS to compare with the PC's screen, and the device name the PC will register this phone under. */
        void onSas(String sas, String deviceName);

        /**
         * False after {@link #HINT_AFTER_FAILURES} network failures in a row while the flow keeps retrying, true when
         * the PC answers again.
         */
        default void onConnection(boolean answering) {}
    }

    static final class Result {
        final String deviceId;
        final String token;
        final long expiresAt;

        Result(String deviceId, String token, long expiresAt) {
            this.deviceId = deviceId;
            this.token = token;
            this.expiresAt = expiresAt;
        }

        @Override
        public String toString() {
            return "Result{" + deviceId + "}";
        }
    }

    private final PinnedHttps http;
    private final String code;
    private final Timing timing;
    private final Object lock = new Object();
    private volatile boolean aborted;
    /** Guarded by {@link #lock}. */
    private boolean held;

    PairingFlow(PinnedHttps http, String code) {
        this(http, code, Timing.DEFAULT);
    }

    PairingFlow(PinnedHttps http, String code, Timing timing) {
        this.http = http;
        this.code = code;
        this.timing = timing;
    }

    void abort() {
        aborted = true;
        synchronized (lock) {
            lock.notifyAll();
        }
    }

    /** The app left the screen: no new request until {@link #release()} (one in flight finishes). */
    void hold() {
        synchronized (lock) {
            held = true;
        }
    }

    /** The app is on screen again: the next request goes out at once. */
    void release() {
        synchronized (lock) {
            held = false;
            lock.notifyAll();
        }
    }

    Result run(Listener listener) throws Failed {
        long started = System.nanoTime();
        String claim = open(listener);
        Retry retry = new Retry(listener, started + timing.approvalMs * 1_000_000);
        while (true) {
            pause(true);
            if (elapsedMs(started) > timing.maxWaitMs) {
                throw new Failed(retry.failures > 0 ? Failure.CONNECTION_LOST : Failure.EXPIRED);
            }
            String state;
            try {
                state = state(claim);
            } catch (Failed failed) {
                retry.failed(failed);
                continue;
            }
            retry.answered();
            switch (state) {
                case "pending":
                    continue;
                case "approved":
                    return claim(claim, new Retry(listener, System.nanoTime() + timing.claimMs * 1_000_000));
                case "rejected":
                    throw new Failed(Failure.REJECTED);
                case "cancelled":
                    throw new Failed(Failure.CANCELLED);
                default:
                    // expired, claimed (not by us), unknown (the gateway restarted: pairings are memory only), none
                    throw new Failed(Failure.EXPIRED);
            }
        }
    }

    /** Spends the link's one-time code; retried only when the app left the screen while it was in flight. */
    private String open(Listener listener) throws Failed {
        PinnedHttps.Response response;
        while (true) {
            try {
                response = request(false, null, "/auth/connect/" + code);
                break;
            } catch (Failed failed) {
                if (failed.failure != Failure.UNREACHABLE || !isHeld()) throw failed;
                pause(false);
            }
        }
        if (response.status == 410) throw new Failed(Failure.EXPIRED);
        if (response.status == 429) throw new Failed(Failure.RATE_LIMITED);
        if (response.status != 200) throw new Failed(Failure.PROTOCOL);
        JSONObject json = parse(response.body);
        String claim = Json.string(json, "claim");
        String sas = Json.string(json, "sas");
        if (claim == null || !CLAIM.matcher(claim).matches() || sas == null || !SAS.matcher(sas).matches()) {
            throw new Failed(Failure.PROTOCOL);
        }
        checkAborted();
        listener.onSas(sas, PairingLink.cleanName(Json.string(json, "name")));
        return claim;
    }

    /** One poll; a transient failure is {@link Failure#UNREACHABLE} so the loop can retry it. */
    private String state(String claim) throws Failed {
        PinnedHttps.Response response = request(false, claim, "/own/pairing");
        if (response.status == 429 || response.status >= 500) throw new Failed(Failure.UNREACHABLE);
        if (response.status != 200) throw new Failed(Failure.PROTOCOL);
        String state = Json.string(parse(response.body), "state");
        if (state == null) throw new Failed(Failure.PROTOCOL);
        return state;
    }

    /** The claim, retried on network failures until the claim window passes. */
    private Result claim(String claim, Retry retry) throws Failed {
        while (true) {
            try {
                Result result = claimOnce(claim);
                retry.answered();
                return result;
            } catch (Failed failed) {
                retry.failed(failed);
            }
            pause(true);
        }
    }

    private Result claimOnce(String claim) throws Failed {
        checkAborted();
        PinnedHttps.Response response = request(true, claim, "/own/pairing/claim");
        if (response.status == 401 || response.status == 410) throw new Failed(Failure.EXPIRED);
        if (response.status == 429) throw new Failed(Failure.RATE_LIMITED);
        if (response.status != 200) throw new Failed(Failure.PROTOCOL);
        JSONObject json = parse(response.body);
        String deviceId = Json.string(json, "deviceId");
        String token = Json.string(json, "token");
        Long expiresAt = Json.number(json, "expiresAt");
        if (deviceId == null || !DEVICE_ID.matcher(deviceId).matches() || token == null || !TOKEN.matcher(token).matches()
                || expiresAt == null) {
            throw new Failed(Failure.PROTOCOL);
        }
        return new Result(deviceId, token, expiresAt);
    }

    private PinnedHttps.Response request(boolean post, String claim, String path) throws Failed {
        checkAborted();
        Map<String, String> headers = new HashMap<>();
        headers.put("Accept", "application/json");
        if (claim != null) headers.put("x-own-pairing", claim);
        try {
            PinnedHttps.Response response = post ? http.post(path, headers, "{}") : http.get(path, headers);
            checkAborted();
            return response;
        } catch (IOException e) {
            checkAborted();
            throw new Failed(PinnedHttps.isPinFailure(e) ? Failure.PIN_MISMATCH : Failure.UNREACHABLE);
        }
    }

    /**
     * Waits one poll interval (or not at all without {@code interval}), and for as long as the flow is held; after a
     * hold the next request goes out at once.
     */
    private void pause(boolean interval) throws Failed {
        synchronized (lock) {
            long until = System.nanoTime() + (interval ? timing.pollMs * 1_000_000 : 0);
            while (!aborted) {
                if (held) {
                    waitLocked(0);
                    until = System.nanoTime();
                    continue;
                }
                long left = until - System.nanoTime();
                if (left <= 0) break;
                waitLocked(Math.max(1, left / 1_000_000));
            }
        }
        checkAborted();
    }

    /** With {@link #lock} held; 0 waits until notified. */
    private void waitLocked(long ms) {
        try {
            lock.wait(ms);
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            aborted = true;
        }
    }

    private boolean isHeld() {
        synchronized (lock) {
            return held;
        }
    }

    private static long elapsedMs(long since) {
        return (System.nanoTime() - since) / 1_000_000;
    }

    /** Network failures of one step: retried until {@code deadline} (nanoTime); failures while held do not count. */
    private final class Retry {
        private final Listener listener;
        private final long deadline;
        int failures;

        Retry(Listener listener, long deadline) {
            this.listener = listener;
            this.deadline = deadline;
        }

        void failed(Failed failed) throws Failed {
            if (failed.failure != Failure.UNREACHABLE) throw failed;
            if (isHeld()) return;
            failures++;
            if (System.nanoTime() > deadline) throw new Failed(Failure.CONNECTION_LOST);
            if (failures == HINT_AFTER_FAILURES) listener.onConnection(false);
        }

        void answered() {
            if (failures >= HINT_AFTER_FAILURES) listener.onConnection(true);
            failures = 0;
        }
    }

    private void checkAborted() throws Failed {
        if (aborted) throw new Failed(Failure.ABORTED);
    }

    private static JSONObject parse(String body) throws Failed {
        try {
            return new JSONObject(body);
        } catch (JSONException | NullPointerException e) {
            throw new Failed(Failure.PROTOCOL);
        }
    }
}
