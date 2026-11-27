package dev.own.opencode.android;

import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Where the app reaches a PC's app listener over TCP (08-app-access.md §3.1): {@code host:port}, IPv6 as
 * {@code [addr]:port}. The order of a PC's routes is its preference (tailnet first).
 */
final class Route {
    private static final Pattern BRACKETED = Pattern.compile("\\[([0-9A-Fa-f:.]{2,45})\\]:([0-9]{1,5})");
    private static final Pattern PLAIN = Pattern.compile("([A-Za-z0-9.-]{1,253}):([0-9]{1,5})");
    private static final Pattern LABEL = Pattern.compile("[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?");
    private static final Pattern IPV4 = Pattern.compile("([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})\\.([0-9]{1,3})");
    /** A PC never needs more; the cap keeps a hostile link or response from making the proxy try forever. */
    static final int MAX_ROUTES = 8;

    final String host;
    final int port;

    private Route(String host, int port) {
        this.host = host;
        this.port = port;
    }

    /** Parses one route; throws {@link IllegalArgumentException} (without echoing the input) when it is not one. */
    static Route parse(String value) {
        if (value == null) throw new IllegalArgumentException("route missing");
        Matcher bracketed = BRACKETED.matcher(value);
        if (bracketed.matches()) {
            String address = bracketed.group(1).toLowerCase(Locale.ROOT);
            if (!address.contains(":") || address.contains(":::")) throw new IllegalArgumentException("bad IPv6 route");
            return new Route(address, port(bracketed.group(2)));
        }
        Matcher plain = PLAIN.matcher(value);
        if (!plain.matches()) throw new IllegalArgumentException("bad route");
        String host = plain.group(1).toLowerCase(Locale.ROOT);
        if (!isIpv4(host) && !isDnsName(host)) throw new IllegalArgumentException("bad route host");
        return new Route(host, port(plain.group(2)));
    }

    /** The valid routes of {@code values} in order, without duplicates, at most {@link #MAX_ROUTES}. */
    static List<Route> parseAll(Collection<String> values) {
        List<Route> routes = new ArrayList<>();
        for (String value : values) {
            try {
                Route route = parse(value);
                if (!routes.contains(route)) routes.add(route);
            } catch (IllegalArgumentException ignored) {
                // An invalid entry is skipped; callers decide whether an empty result is acceptable.
            }
            if (routes.size() == MAX_ROUTES) break;
        }
        return routes;
    }

    /**
     * The order the proxy tries {@code routes} in (08 §3.4 1): the last route that connected first, then the others in
     * their stored (preference) order.
     */
    static List<Route> order(List<Route> routes, Route last) {
        List<Route> ordered = new ArrayList<>(routes.size());
        if (last != null && routes.contains(last)) ordered.add(last);
        for (Route route : routes) if (!route.equals(last)) ordered.add(route);
        return ordered;
    }

    private static int port(String digits) {
        int port = Integer.parseInt(digits);
        if (port < 1 || port > 65535) throw new IllegalArgumentException("bad route port");
        return port;
    }

    private static boolean isIpv4(String host) {
        Matcher matcher = IPV4.matcher(host);
        if (!matcher.matches()) return false;
        for (int i = 1; i <= 4; i++) if (Integer.parseInt(matcher.group(i)) > 255) return false;
        return true;
    }

    private static boolean isDnsName(String host) {
        if (host.length() > 253 || host.startsWith(".") || host.endsWith(".")) return false;
        String[] labels = host.split("\\.", -1);
        for (String label : labels) if (!LABEL.matcher(label).matches()) return false;
        // An all-numeric last label would be a malformed IPv4 address, not a name.
        return !labels[labels.length - 1].matches("[0-9]+");
    }

    @Override
    public String toString() {
        return host.indexOf(':') >= 0 ? "[" + host + "]:" + port : host + ":" + port;
    }

    @Override
    public boolean equals(Object other) {
        return other instanceof Route && ((Route) other).host.equals(host) && ((Route) other).port == port;
    }

    @Override
    public int hashCode() {
        return host.hashCode() * 31 + port;
    }
}
