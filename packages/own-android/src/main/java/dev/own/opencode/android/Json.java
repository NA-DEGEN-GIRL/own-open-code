package dev.own.opencode.android;

import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * Typed reads from org.json objects. Android's org.json and the reference implementation (used by the JVM tests)
 * differ in {@code optString}/{@code optLong} handling of null and wrong types, so values are checked by type here.
 */
final class Json {
    private Json() {}

    static String string(JSONObject object, String key) {
        Object value = object.opt(key);
        return value instanceof String ? (String) value : null;
    }

    /** A finite integral number, or null. */
    static Long number(JSONObject object, String key) {
        Object value = object.opt(key);
        if (!(value instanceof Number)) return null;
        double asDouble = ((Number) value).doubleValue();
        if (Double.isNaN(asDouble) || Double.isInfinite(asDouble)) return null;
        return ((Number) value).longValue();
    }

    /** The string entries of an array value (others skipped); empty when the key is missing or not an array. */
    static List<String> strings(JSONObject object, String key) {
        List<String> out = new ArrayList<>();
        Object value = object.opt(key);
        if (!(value instanceof JSONArray)) return out;
        JSONArray array = (JSONArray) value;
        for (int i = 0; i < array.length(); i++) {
            Object entry = array.opt(i);
            if (entry instanceof String) out.add((String) entry);
        }
        return out;
    }
}
