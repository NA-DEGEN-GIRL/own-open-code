package dev.own.opencode.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertThrows;
import static org.junit.Assert.assertTrue;

import java.util.Arrays;
import org.junit.Test;

public class PairingLinkTest {
    private static final String PIN = FakeGateway.PIN;
    private static final String CODE = "Q2xhaW1Db2RlXzEyMzQ1Ng";
    private static final String BASE = "ownpc://pair?v=1&k=abcdefghijkl&p=" + PIN + "&c=" + CODE;

    @Test
    public void parsesAFullLink() throws Exception {
        PairingLink link = PairingLink.parse(BASE + "&n=%EB%82%B4%20PC&r=pc.tail1234.ts.net:28540&r=%5Bfd7a%3A115c%3A%3A1%5D%3A28541");
        assertEquals("abcdefghijkl", link.pcKey);
        assertEquals(PIN, link.pin);
        assertEquals(CODE, link.code);
        assertEquals("내 PC", link.name);
        assertEquals("abcdefghijkl.ownpc.internal", link.appHost());
        assertEquals(2, link.routes.size());
        assertEquals("pc.tail1234.ts.net:28540", link.routes.get(0).toString());
        assertEquals("[fd7a:115c::1]:28541", link.routes.get(1).toString());
    }

    @Test
    public void acceptsCommonVariations() throws Exception {
        // Upper-case scheme, a slash before the query, surrounding whitespace, '+' for spaces, raw brackets, a fragment
        // and unknown parameters (forward compatible).
        PairingLink link = PairingLink.parse("  OWNPC://pair/?v=1&k=abcdefghijkl&p=" + PIN + "&c=" + CODE
                + "&n=Desk+PC&r=[::1]:28540&x=future#ignored\n");
        assertEquals("Desk PC", link.name);
        assertEquals("[::1]:28540", link.routes.get(0).toString());
    }

    @Test
    public void nameIsOptionalAndCleaned() throws Exception {
        assertEquals("PC", PairingLink.parse(BASE + "&r=a.net:1").name);
        assertEquals("PC", PairingLink.parse(BASE + "&n=%20%0A&r=a.net:1").name);
        // Controls and bidi overrides are removed, runs of whitespace collapse.
        assertEquals("evil gpj.exe", PairingLink.parse(BASE + "&n=evil%E2%80%AE%20%20gpj.exe%07&r=a.net:1").name);
        StringBuilder longName = new StringBuilder();
        for (int i = 0; i < 100; i++) longName.append('가');
        assertEquals(PairingLink.MAX_NAME, PairingLink.parse(BASE + "&n=" + longName + "&r=a.net:1").name.length());
    }

    @Test
    public void skipsInvalidRoutesButNeedsOne() throws Exception {
        assertEquals(1, PairingLink.parse(BASE + "&r=bad&r=a.net:1").routes.size());
        assertThrows(PairingLink.Invalid.class, () -> PairingLink.parse(BASE));
        assertThrows(PairingLink.Invalid.class, () -> PairingLink.parse(BASE + "&r=bad&r=host:0"));
    }

    @Test
    public void rejectsBadVersionKeyPinOrCode() {
        String routes = "&r=a.net:1";
        for (String bad : Arrays.asList(
                null,
                "",
                "https://example.com/pair?v=1",
                "ownpc://pairx?v=1&k=abcdefghijkl&p=" + PIN + "&c=" + CODE + routes,
                "ownpc://other?v=1&k=abcdefghijkl&p=" + PIN + "&c=" + CODE + routes,
                "ownpc://pair?k=abcdefghijkl&p=" + PIN + "&c=" + CODE + routes,
                "ownpc://pair?v=2&k=abcdefghijkl&p=" + PIN + "&c=" + CODE + routes,
                "ownpc://pair?v=1&v=1&k=abcdefghijkl&p=" + PIN + "&c=" + CODE + routes,
                "ownpc://pair?v=1&k=ABCDEFGHIJKL&p=" + PIN + "&c=" + CODE + routes,
                "ownpc://pair?v=1&k=abcdefghijk&p=" + PIN + "&c=" + CODE + routes,
                "ownpc://pair?v=1&k=abcdefghijk1&p=" + PIN + "&c=" + CODE + routes,
                "ownpc://pair?v=1&k=abcdefghijkl&k=bbcdefghijkl&p=" + PIN + "&c=" + CODE + routes,
                "ownpc://pair?v=1&k=abcdefghijkl&p=" + PIN.substring(1) + "&c=" + CODE + routes,
                "ownpc://pair?v=1&k=abcdefghijkl&p=" + PIN + "=&c=" + CODE + routes,
                "ownpc://pair?v=1&k=abcdefghijkl&c=" + CODE + routes,
                "ownpc://pair?v=1&k=abcdefghijkl&p=" + PIN + "&c=short" + routes,
                "ownpc://pair?v=1&k=abcdefghijkl&p=" + PIN + "&c=" + CODE + "%2B" + routes,
                "ownpc://pair?v=1&k=abcdefghijkl&p=" + PIN + routes,
                "ownpc://pair?v=1&k=abcdefghijkl&p=" + PIN + "&c=" + CODE + "&n=%zz" + routes)) {
            assertThrows(String.valueOf(bad), PairingLink.Invalid.class, () -> PairingLink.parse(bad));
        }
    }

    @Test
    public void conflictsOnlyWithTheSamePcUnderAnotherKey() throws Exception {
        Route route = Route.parse("a.net:1");
        PcRecord stored = new PcRecord("abcdefghijkl", "내 PC", PIN, Arrays.asList(route), route, "dev_1", 1L, 0L);
        PcRecord otherPc = new PcRecord("bbcdefghijkl", "다른 PC", FakeGateway.OTHER_PIN, Arrays.asList(route), route,
                "dev_2", 1L, 0L);
        PairingLink forged = PairingLink.parse("ownpc://pair?v=1&k=abcdefghijkl&p=" + FakeGateway.OTHER_PIN + "&c=" + CODE
                + "&r=evil.example:443");
        assertTrue(forged.conflictsWith(stored));
        // Pairing the same PC again under its stored key is allowed, as are new PCs.
        PairingLink again = PairingLink.parse(BASE + "&r=a.net:1");
        assertFalse(again.conflictsWith(stored));
        assertFalse(forged.conflictsWith(null));
        assertFalse(forged.conflictsWith(otherPc));
    }

    @Test
    public void findsAStoredPcOfTheSameNameUnderAnotherKey() throws Exception {
        Route route = Route.parse("a.net:1");
        PcRecord mine = new PcRecord("abcdefghijkl", "내 PC", PIN, Arrays.asList(route), route, "dev_1", 1L, 0L);
        // Another PC (any pin) that calls itself by the stored PC's name, differing only in case.
        PairingLink lookalike = PairingLink.parse("ownpc://pair?v=1&k=zzcdefghijkl&p=" + FakeGateway.OTHER_PIN + "&c="
                + CODE + "&n=%EB%82%B4%20pc&r=evil.example:443");
        assertEquals(mine, lookalike.sameNameAs(Arrays.asList(mine)));
        // The stored PC itself (pairing again) and other names are not look-alikes.
        assertEquals(null, PairingLink.parse(BASE + "&n=%EB%82%B4%20PC&r=a.net:1").sameNameAs(Arrays.asList(mine)));
        assertEquals(null, PairingLink.parse("ownpc://pair?v=1&k=zzcdefghijkl&p=" + PIN + "&c=" + CODE
                + "&n=Desk&r=a.net:1").sameNameAs(Arrays.asList(mine)));
        assertEquals(null, lookalike.sameNameAs(Arrays.<PcRecord>asList()));
    }

    @Test
    public void neverEchoesTheSecretCode() throws Exception {
        PairingLink link = PairingLink.parse(BASE + "&r=a.net:1");
        assertFalse(link.toString().contains(CODE));
        PairingLink.Invalid invalid = assertThrows(PairingLink.Invalid.class,
                () -> PairingLink.parse("ownpc://pair?v=2&k=abcdefghijkl&p=" + PIN + "&c=" + CODE + "&r=a.net:1"));
        assertFalse(invalid.getMessage().contains(CODE));
    }
}
