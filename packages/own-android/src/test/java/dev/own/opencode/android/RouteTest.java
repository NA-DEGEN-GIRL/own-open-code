package dev.own.opencode.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertThrows;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import org.junit.Test;

public class RouteTest {
    @Test
    public void parsesNamesAddressesAndIpv6() {
        assertEquals("pc.tail1234.ts.net:28540", Route.parse("pc.tail1234.ts.net:28540").toString());
        assertEquals("myhome.ddns.net:28541", Route.parse("MyHome.DDNS.net:28541").toString());
        assertEquals("192.168.0.10:28541", Route.parse("192.168.0.10:28541").toString());
        assertEquals("[fd7a:115c:a1e0::1]:28540", Route.parse("[FD7A:115C:A1E0::1]:28540").toString());
        assertEquals("[::1]:443", Route.parse("[::1]:443").toString());
        Route route = Route.parse("[::ffff:192.0.2.1]:80");
        assertEquals("::ffff:192.0.2.1", route.host);
        assertEquals(80, route.port);
        assertEquals("localhost:1", Route.parse("localhost:1").toString());
    }

    @Test
    public void rejectsMalformedRoutes() {
        for (String bad : Arrays.asList(null, "", "host", "host:", ":80", "host:0", "host:65536", "host:-1", "host:+80",
                "host:80/path", "http://host:80", " host:80", "host :80", "[::1]", "::1:80", "[::1]80", "[zz::1]:80",
                "[1.2.3.4]:80", "a..b:80", "-a.com:80", "a-.com:80", ".a.com:80", "a.com.:80", "1.2.3.256:80",
                "1.2.3:80", "under_score.net:80", "host:123456", "user@host:80")) {
            assertThrows(String.valueOf(bad), IllegalArgumentException.class, () -> Route.parse(bad));
        }
    }

    @Test
    public void parseAllSkipsInvalidDeduplicatesAndCaps() {
        List<String> values = new ArrayList<>(Arrays.asList("a.net:1", "bad", "A.net:1", "b.net:2"));
        for (int i = 3; i < 20; i++) values.add("h" + i + ".net:" + i);
        List<Route> routes = Route.parseAll(values);
        assertEquals(Route.MAX_ROUTES, routes.size());
        assertEquals("a.net:1", routes.get(0).toString());
        assertEquals("b.net:2", routes.get(1).toString());
    }

    @Test
    public void orderPutsTheLastWorkingRouteFirst() {
        Route tailnet = Route.parse("pc.tail1234.ts.net:28540");
        Route direct = Route.parse("myhome.ddns.net:28541");
        Route lan = Route.parse("192.168.0.10:28541");
        List<Route> routes = Arrays.asList(tailnet, direct, lan);
        assertEquals(Arrays.asList(tailnet, direct, lan), Route.order(routes, null));
        assertEquals(Arrays.asList(lan, tailnet, direct), Route.order(routes, lan));
        assertEquals(Arrays.asList(tailnet, direct, lan), Route.order(routes, Route.parse("gone.net:1")));
    }
}
