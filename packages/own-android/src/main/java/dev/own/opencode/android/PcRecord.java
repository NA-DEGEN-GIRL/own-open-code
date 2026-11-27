package dev.own.opencode.android;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

/**
 * A paired PC as the app stores it (08-app-access.md §3.5): {@code pcKey, name, pin, routes, lastRoute, deviceId,
 * expiresAt, addedAt}. The device token is not part of it; it lives only in the WebView cookie store.
 */
final class PcRecord {
    final String pcKey;
    final String name;
    final String pin;
    final List<Route> routes;
    final Route lastRoute;
    final String deviceId;
    /** Absolute expiry of the device token, epoch ms (the gateway may expire it earlier when idle). */
    final long expiresAt;
    final long addedAt;

    PcRecord(String pcKey, String name, String pin, List<Route> routes, Route lastRoute, String deviceId, long expiresAt, long addedAt) {
        this.pcKey = pcKey;
        this.name = name;
        this.pin = pin;
        this.routes = Collections.unmodifiableList(new ArrayList<>(routes));
        this.lastRoute = lastRoute != null && routes.contains(lastRoute) ? lastRoute : null;
        this.deviceId = deviceId;
        this.expiresAt = expiresAt;
        this.addedAt = addedAt;
    }

    String appHost() {
        return AppHost.host(pcKey);
    }

    String origin() {
        return AppHost.origin(pcKey);
    }

    PcRecord withLastRoute(Route route) {
        return new PcRecord(pcKey, name, pin, routes, route, deviceId, expiresAt, addedAt);
    }

    JSONObject toJson() throws JSONException {
        JSONArray list = new JSONArray();
        for (Route route : routes) list.put(route.toString());
        JSONObject json = new JSONObject();
        json.put("pcKey", pcKey);
        json.put("name", name);
        json.put("pin", pin);
        json.put("routes", list);
        if (lastRoute != null) json.put("lastRoute", lastRoute.toString());
        json.put("deviceId", deviceId);
        json.put("expiresAt", expiresAt);
        json.put("addedAt", addedAt);
        return json;
    }

    /** A stored record, or null when it is not a valid one (a corrupt entry is dropped, not fatal). */
    static PcRecord fromJson(JSONObject json) {
        String pcKey = Json.string(json, "pcKey");
        String pin = Json.string(json, "pin");
        String deviceId = Json.string(json, "deviceId");
        Long expiresAt = Json.number(json, "expiresAt");
        Long addedAt = Json.number(json, "addedAt");
        List<Route> routes = Route.parseAll(Json.strings(json, "routes"));
        if (!AppHost.isPcKey(pcKey) || !Pins.isPin(pin) || deviceId == null || expiresAt == null || routes.isEmpty()) return null;
        String last = Json.string(json, "lastRoute");
        Route lastRoute = null;
        if (last != null) {
            try {
                lastRoute = Route.parse(last);
            } catch (IllegalArgumentException ignored) {
                // Dropped; the proxy falls back to the preference order.
            }
        }
        return new PcRecord(pcKey, PairingLink.cleanName(Json.string(json, "name")), pin, routes, lastRoute, deviceId,
                expiresAt, addedAt == null ? 0 : addedAt);
    }

    /** The outcome of a {@code GET /own/routes} answer (08 §3.6). */
    enum Refresh { UPDATED, UNCHANGED, PIN_CHANGED, INVALID }

    static final class RouteUpdate {
        final Refresh outcome;
        /** The record to store for {@link Refresh#UPDATED}, else the unchanged record. */
        final PcRecord record;

        RouteUpdate(Refresh outcome, PcRecord record) {
            this.outcome = outcome;
            this.record = record;
        }
    }

    /**
     * Applies {@code {pcKey, pin, name, routes}}. A different pin changes nothing and asks for a new pairing; a
     * response for another PC, without a usable route, or not JSON is ignored.
     */
    RouteUpdate applyRoutes(String body) {
        JSONObject json;
        try {
            json = new JSONObject(body);
        } catch (JSONException | NullPointerException e) {
            return new RouteUpdate(Refresh.INVALID, this);
        }
        String key = Json.string(json, "pcKey");
        if (key != null && !key.equals(pcKey)) return new RouteUpdate(Refresh.INVALID, this);
        String newPin = Json.string(json, "pin");
        if (!Pins.isPin(newPin)) return new RouteUpdate(Refresh.INVALID, this);
        if (!newPin.equals(pin)) return new RouteUpdate(Refresh.PIN_CHANGED, this);
        List<Route> newRoutes = Route.parseAll(Json.strings(json, "routes"));
        if (newRoutes.isEmpty()) return new RouteUpdate(Refresh.INVALID, this);
        String rawName = Json.string(json, "name");
        String newName = rawName == null ? name : PairingLink.cleanName(rawName);
        if (newRoutes.equals(routes) && newName.equals(name)) return new RouteUpdate(Refresh.UNCHANGED, this);
        return new RouteUpdate(Refresh.UPDATED,
                new PcRecord(pcKey, newName, pin, newRoutes, lastRoute, deviceId, expiresAt, addedAt));
    }
}
