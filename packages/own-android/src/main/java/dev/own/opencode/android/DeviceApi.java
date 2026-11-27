package dev.own.opencode.android;

import java.io.IOException;
import java.util.HashMap;
import java.util.Map;
import org.json.JSONException;
import org.json.JSONObject;

/** Device-authenticated calls the app makes itself (Bearer token read from the cookie store). */
final class DeviceApi {
    /** The revoke call is best effort while the user waits for the PC to disappear from the list (08 §3.6a). */
    static final int REVOKE_TIMEOUT_MS = 5000;

    private DeviceApi() {}

    /**
     * {@code POST /own/device/revoke} (08-app-access.md §3.6a): revokes this device on the PC, like the PC's own
     * "폐기". True only for {@code 200 {revoked:true}}; an unreachable PC, a dead token (401) or a pin mismatch (the token
     * is never sent then: the handshake fails first) are false, never an exception.
     */
    static boolean revoke(PinnedHttps http, String token) {
        Map<String, String> headers = new HashMap<>();
        headers.put("Authorization", "Bearer " + token);
        headers.put("Accept", "application/json");
        try {
            PinnedHttps.Response response = http.post("/own/device/revoke", headers, "{}");
            return response.status == 200 && new JSONObject(response.body).optBoolean("revoked", false);
        } catch (IOException | JSONException | RuntimeException e) {
            return false;
        }
    }
}
