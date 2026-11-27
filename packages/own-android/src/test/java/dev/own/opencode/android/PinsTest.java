package dev.own.opencode.android;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import java.io.InputStream;
import java.security.cert.CertificateFactory;
import java.security.cert.X509Certificate;
import org.junit.Test;

public class PinsTest {
    static X509Certificate certificate(String name) throws Exception {
        try (InputStream in = PinsTest.class.getResourceAsStream("/" + name + ".pem")) {
            return (X509Certificate) CertificateFactory.getInstance("X.509").generateCertificate(in);
        }
    }

    @Test
    public void pinIsBase64UrlSha256OfTheSubjectPublicKeyInfo() throws Exception {
        // Expected values computed with openssl, not with this code (see FakeGateway).
        assertEquals(FakeGateway.PIN, Pins.of(certificate("gateway")));
        assertEquals(FakeGateway.OTHER_PIN, Pins.of(certificate("other")));
    }

    @Test
    public void matchesOnlyTheSameKey() throws Exception {
        assertTrue(Pins.matches(certificate("gateway"), FakeGateway.PIN));
        assertFalse(Pins.matches(certificate("other"), FakeGateway.PIN));
        assertFalse(Pins.matches(null, FakeGateway.PIN));
        assertFalse(Pins.matches(certificate("gateway"), "not a pin"));
    }

    @Test
    public void validatesPinShape() {
        assertTrue(Pins.isPin(FakeGateway.PIN));
        assertFalse(Pins.isPin(null));
        assertFalse(Pins.isPin(FakeGateway.PIN.substring(1)));
        assertFalse(Pins.isPin(FakeGateway.PIN + "="));
        assertFalse(Pins.isPin(FakeGateway.PIN.replace('-', '+')));
        // Same length, but the last char carries non-zero padding bits: not a canonical 32-byte encoding.
        assertFalse(Pins.isPin(FakeGateway.PIN.substring(0, 42) + "t"));
    }
}
