package dev.own.opencode.android;

import java.util.ArrayList;
import java.util.Arrays;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/** An in-memory {@link RouteProxy.Table} that records which routes connected. */
final class TestTable implements RouteProxy.Table {
    final Map<String, List<Route>> routes = new ConcurrentHashMap<>();
    final Map<String, Route> last = new ConcurrentHashMap<>();
    final List<String> connected = Collections.synchronizedList(new ArrayList<>());

    TestTable put(String pcKey, Route... list) {
        routes.put(pcKey, Arrays.asList(list));
        return this;
    }

    @Override
    public List<Route> routes(String pcKey) {
        return routes.get(pcKey);
    }

    @Override
    public Route lastRoute(String pcKey) {
        return last.get(pcKey);
    }

    @Override
    public void connected(String pcKey, Route route) {
        last.put(pcKey, route);
        connected.add(pcKey + "=" + route);
    }
}
