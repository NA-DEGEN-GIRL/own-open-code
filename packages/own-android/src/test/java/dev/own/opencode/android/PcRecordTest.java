package dev.own.opencode.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertSame;

import java.util.Arrays;
import org.json.JSONObject;
import org.junit.Test;

public class PcRecordTest {
    private static final Route TAILNET = Route.parse("pc.tail1234.ts.net:28540");
    private static final Route DIRECT = Route.parse("[2001:db8::1]:28541");

    private static PcRecord record() {
        return new PcRecord(FakeGateway.PC_KEY, "내 PC", FakeGateway.PIN, Arrays.asList(TAILNET, DIRECT), DIRECT, "dev_1",
                1792592000000L, 1790000000000L);
    }

    private static String routes(String pin, String... routes) {
        StringBuilder list = new StringBuilder();
        for (String route : routes) list.append(list.length() == 0 ? "" : ",").append('"').append(route).append('"');
        return "{\"pcKey\":\"" + FakeGateway.PC_KEY + "\",\"pin\":\"" + pin + "\",\"name\":\"내 PC\",\"routes\":[" + list + "]}";
    }

    @Test
    public void roundTripsThroughJson() throws Exception {
        PcRecord copy = PcRecord.fromJson(new JSONObject(record().toJson().toString()));
        assertEquals(FakeGateway.PC_KEY, copy.pcKey);
        assertEquals("내 PC", copy.name);
        assertEquals(FakeGateway.PIN, copy.pin);
        assertEquals(Arrays.asList(TAILNET, DIRECT), copy.routes);
        assertEquals(DIRECT, copy.lastRoute);
        assertEquals("dev_1", copy.deviceId);
        assertEquals(1792592000000L, copy.expiresAt);
        assertEquals(1790000000000L, copy.addedAt);
        assertEquals("https://abcdefghijkl.ownpc.internal", copy.origin());
    }

    @Test
    public void dropsInvalidStoredRecords() throws Exception {
        JSONObject json = record().toJson();
        json.put("pin", "short");
        assertNull(PcRecord.fromJson(json));
        json = record().toJson();
        json.put("routes", new org.json.JSONArray());
        assertNull(PcRecord.fromJson(json));
        json = record().toJson();
        json.remove("deviceId");
        assertNull(PcRecord.fromJson(json));
        json = record().toJson();
        json.put("lastRoute", "elsewhere.net:1");
        assertNull(PcRecord.fromJson(json).lastRoute);
    }

    @Test
    public void routesRefreshUpdatesRoutesWithTheSamePin() {
        PcRecord.RouteUpdate update = record().applyRoutes(routes(FakeGateway.PIN, "[2001:db8::1]:28541", "new.ddns.net:30000"));
        assertEquals(PcRecord.Refresh.UPDATED, update.outcome);
        assertEquals(Arrays.asList(DIRECT, Route.parse("new.ddns.net:30000")), update.record.routes);
        assertEquals(DIRECT, update.record.lastRoute);
        assertEquals("dev_1", update.record.deviceId);

        PcRecord.RouteUpdate dropped = record().applyRoutes(routes(FakeGateway.PIN, "new.ddns.net:30000"));
        assertNull(dropped.record.lastRoute);
    }

    @Test
    public void routesRefreshChangesNothingWhenThePinDiffers() {
        PcRecord original = record();
        PcRecord.RouteUpdate update = original.applyRoutes(routes(FakeGateway.OTHER_PIN, "evil.example:443"));
        assertEquals(PcRecord.Refresh.PIN_CHANGED, update.outcome);
        assertSame(original, update.record);
    }

    @Test
    public void routesRefreshIgnoresUnusableAnswers() {
        PcRecord original = record();
        assertEquals(PcRecord.Refresh.UNCHANGED,
                original.applyRoutes(routes(FakeGateway.PIN, "pc.tail1234.ts.net:28540", "[2001:db8::1]:28541")).outcome);
        assertEquals(PcRecord.Refresh.INVALID, original.applyRoutes(routes(FakeGateway.PIN)).outcome);
        assertEquals(PcRecord.Refresh.INVALID, original.applyRoutes(routes(FakeGateway.PIN, "bad")).outcome);
        assertEquals(PcRecord.Refresh.INVALID, original.applyRoutes(routes("short", "a.net:1")).outcome);
        assertEquals(PcRecord.Refresh.INVALID,
                original.applyRoutes(routes(FakeGateway.PIN, "a.net:1").replace(FakeGateway.PC_KEY, "bbbbbbbbbbbb")).outcome);
        assertEquals(PcRecord.Refresh.INVALID, original.applyRoutes("<html>").outcome);
        assertEquals(PcRecord.Refresh.INVALID, original.applyRoutes(null).outcome);
    }

    @Test
    public void deviceCookieHasTheContractAttributes() {
        assertEquals("own_device=abc; Path=/; Max-Age=3600; Secure; HttpOnly; SameSite=Strict", Cookies.device("abc", 3600));
        assertEquals("own_device=; Path=/; Max-Age=0; Secure; HttpOnly; SameSite=Strict", Cookies.expiredDevice());
        assertEquals(3600, Cookies.maxAge(1_003_600_500L, 1_000_000_000L));
        assertEquals(0, Cookies.maxAge(1L, 2_000L));
    }

    @Test
    public void findsTheDeviceCookie() {
        assertEquals("tok", Cookies.find("a=1; own_device=tok; b=2", Cookies.DEVICE));
        assertEquals("tok", Cookies.find("own_device=tok", Cookies.DEVICE));
        assertNull(Cookies.find("xown_device=tok; own_device_old=1", Cookies.DEVICE));
        assertNull(Cookies.find("own_device=", Cookies.DEVICE));
        assertNull(Cookies.find(null, Cookies.DEVICE));
    }
}
