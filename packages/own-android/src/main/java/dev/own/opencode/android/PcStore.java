package dev.own.opencode.android;

import android.content.Context;
import android.content.SharedPreferences;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * Paired PCs in SharedPreferences ({@code pcs.xml}, one JSON array). Thread-safe: the proxy updates the last route
 * from its own threads. No secrets are stored here (the token is only in the cookie store).
 */
final class PcStore {
    private static final String FILE = "pcs";
    private static final String KEY = "records";

    private final SharedPreferences preferences;
    private final Map<String, PcRecord> records = new LinkedHashMap<>();

    PcStore(Context context) {
        preferences = context.getSharedPreferences(FILE, Context.MODE_PRIVATE);
        try {
            JSONArray array = new JSONArray(preferences.getString(KEY, "[]"));
            for (int i = 0; i < array.length(); i++) {
                JSONObject json = array.optJSONObject(i);
                PcRecord record = json == null ? null : PcRecord.fromJson(json);
                if (record != null) records.put(record.pcKey, record);
            }
        } catch (JSONException ignored) {
            // A corrupt file starts empty; the PCs can be paired again.
        }
    }

    synchronized List<PcRecord> list() {
        return new ArrayList<>(records.values());
    }

    synchronized PcRecord get(String pcKey) {
        return records.get(pcKey);
    }

    /** Adds or replaces (a new pairing of a known PC replaces its record). */
    synchronized void put(PcRecord record) {
        records.remove(record.pcKey);
        records.put(record.pcKey, record);
        save();
    }

    synchronized void remove(String pcKey) {
        if (records.remove(pcKey) != null) save();
    }

    /** Records the route that connected; written only when it changed. */
    synchronized void connected(String pcKey, Route route) {
        PcRecord record = records.get(pcKey);
        if (record == null || route.equals(record.lastRoute) || !record.routes.contains(route)) return;
        records.put(pcKey, record.withLastRoute(route));
        save();
    }

    /** Replaces a record only if it is still the same pairing (a re-pairing in between wins). */
    synchronized void replace(PcRecord expected, PcRecord updated) {
        PcRecord current = records.get(expected.pcKey);
        if (current == null || !current.deviceId.equals(expected.deviceId)) return;
        records.put(updated.pcKey, updated.withLastRoute(current.lastRoute));
        save();
    }

    private void save() {
        JSONArray array = new JSONArray();
        try {
            for (PcRecord record : records.values()) array.put(record.toJson());
        } catch (JSONException e) {
            throw new IllegalStateException(e);
        }
        preferences.edit().putString(KEY, array.toString()).apply();
    }
}
