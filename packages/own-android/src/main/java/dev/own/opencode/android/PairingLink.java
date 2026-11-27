package dev.own.opencode.android;

import java.io.UnsupportedEncodingException;
import java.net.URLDecoder;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;

/**
 * A pairing link (the QR content, 08-app-access.md §3.3):
 * {@code ownpc://pair?v=1&k=<pcKey>&p=<pin>&c=<code>&n=<name>&r=<route>&r=<route>}.
 *
 * <p>{@code c} is a one-time pairing secret: never log a link or this object's fields ({@link #toString()} leaves the
 * code out).
 */
final class PairingLink {
    /** The gateway's pairing code shape (128-bit base64url, packages/own-remote/src/gateway/pairing.ts). */
    private static final Pattern CODE = Pattern.compile("[A-Za-z0-9_-]{16,64}");
    private static final String PREFIX = "ownpc://pair";
    private static final int MAX_LENGTH = 4096;
    static final int MAX_NAME = 64;

    final String pcKey;
    final String pin;
    final String code;
    final String name;
    final List<Route> routes;

    private PairingLink(String pcKey, String pin, String code, String name, List<Route> routes) {
        this.pcKey = pcKey;
        this.pin = pin;
        this.code = code;
        this.name = name;
        this.routes = Collections.unmodifiableList(routes);
    }

    /** Why a link was refused. The message never contains the link. */
    static final class Invalid extends Exception {
        Invalid(String message) {
            super(message);
        }
    }

    static PairingLink parse(String input) throws Invalid {
        if (input == null) throw new Invalid("empty link");
        String link = input.trim();
        if (link.length() > MAX_LENGTH) throw new Invalid("link too long");
        if (!link.regionMatches(true, 0, PREFIX, 0, PREFIX.length())) throw new Invalid("not an ownpc://pair link");
        String rest = link.substring(PREFIX.length());
        if (rest.startsWith("/")) rest = rest.substring(1);
        if (!rest.startsWith("?")) throw new Invalid("not an ownpc://pair link");
        Map<String, List<String>> params = query(rest.substring(1));

        if (!"1".equals(single(params, "v"))) throw new Invalid("unsupported link version");
        String pcKey = single(params, "k");
        if (!AppHost.isPcKey(pcKey)) throw new Invalid("bad pcKey");
        String pin = single(params, "p");
        if (!Pins.isPin(pin)) throw new Invalid("bad pin");
        String code = single(params, "c");
        if (code == null || !CODE.matcher(code).matches()) throw new Invalid("bad code");
        List<String> rawRoutes = params.get("r");
        List<Route> routes = Route.parseAll(rawRoutes == null ? Collections.<String>emptyList() : rawRoutes);
        if (routes.isEmpty()) throw new Invalid("no usable route");
        return new PairingLink(pcKey, pin, code, cleanName(single(params, "n")), routes);
    }

    /**
     * A display name from untrusted text: control and bidi-override characters removed, whitespace collapsed, at most
     * {@link #MAX_NAME} code points, "PC" when nothing is left.
     */
    static String cleanName(String value) {
        if (value == null) return "PC";
        StringBuilder out = new StringBuilder();
        boolean space = false;
        int count = 0;
        for (int i = 0; i < value.length() && count < MAX_NAME; ) {
            int cp = value.codePointAt(i);
            i += Character.charCount(cp);
            if (Character.isWhitespace(cp) || Character.isSpaceChar(cp)) {
                space = out.length() > 0;
                continue;
            }
            if (Character.isISOControl(cp) || isBidiControl(cp) || Character.getType(cp) == Character.FORMAT) continue;
            if (space) {
                out.append(' ');
                count++;
                space = false;
                if (count == MAX_NAME) break;
            }
            out.appendCodePoint(cp);
            count++;
        }
        return out.length() == 0 ? "PC" : out.toString();
    }

    String appHost() {
        return AppHost.host(pcKey);
    }

    /**
     * Whether pairing would replace a stored PC's key (08-app-access.md §3.5). A PC that makes a new key also makes a
     * new pcKey, so the same pcKey with another pin is a forged or corrupt link: refused before any request, the stored
     * record and its cookie stay. The same pin pairs again (for example after the device expired).
     */
    boolean conflictsWith(PcRecord stored) {
        return stored != null && stored.pcKey.equals(pcKey) && !stored.pin.equals(pin);
    }

    /**
     * A stored PC under another pcKey that has this link's name, or null (08-app-access.md §3.5). Any web page can open
     * an {@code ownpc://pair} link and the name is the sender's choice, so a link from another app that names a PC on
     * the list is confirmed with a warning: one tap must not add a look-alike second "My PC".
     */
    PcRecord sameNameAs(List<PcRecord> stored) {
        for (PcRecord record : stored) {
            if (!record.pcKey.equals(pcKey) && record.name.equalsIgnoreCase(name)) return record;
        }
        return null;
    }

    @Override
    public String toString() {
        return "PairingLink{" + pcKey + "}";
    }

    private static boolean isBidiControl(int cp) {
        return (cp >= 0x202A && cp <= 0x202E) || (cp >= 0x2066 && cp <= 0x2069) || cp == 0x200E || cp == 0x200F;
    }

    private static Map<String, List<String>> query(String query) throws Invalid {
        int fragment = query.indexOf('#');
        if (fragment >= 0) query = query.substring(0, fragment);
        Map<String, List<String>> params = new HashMap<>();
        for (String part : query.split("&")) {
            if (part.isEmpty()) continue;
            int eq = part.indexOf('=');
            String key = decode(eq < 0 ? part : part.substring(0, eq));
            String value = eq < 0 ? "" : decode(part.substring(eq + 1));
            List<String> values = params.get(key);
            if (values == null) params.put(key, values = new ArrayList<>());
            values.add(value);
        }
        return params;
    }

    /** The one value of {@code key}, null when absent; a repeated key is refused (no guessing which one counts). */
    private static String single(Map<String, List<String>> params, String key) throws Invalid {
        List<String> values = params.get(key);
        if (values == null) return null;
        if (values.size() != 1) throw new Invalid("repeated parameter " + key);
        return values.get(0);
    }

    private static String decode(String value) throws Invalid {
        try {
            // URLDecoder(String, Charset) needs API 33; the charset-name overload exists everywhere.
            return URLDecoder.decode(value, "UTF-8");
        } catch (IllegalArgumentException | UnsupportedEncodingException e) {
            throw new Invalid("bad percent-encoding");
        }
    }
}
