package dev.own.opencode.android;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.cert.X509Certificate;
import java.util.Base64;
import java.util.regex.Pattern;

/**
 * Key pins (08-app-access.md §3.1): base64url without padding (43 chars) of SHA-256 over the certificate's
 * SubjectPublicKeyInfo DER. A reissued certificate with the same key keeps its pin.
 */
final class Pins {
    private static final Pattern SHAPE = Pattern.compile("[A-Za-z0-9_-]{43}");

    private Pins() {}

    /** True when {@code value} is a well-formed pin: 43 base64url chars that decode to exactly 32 bytes. */
    static boolean isPin(String value) {
        if (value == null || !SHAPE.matcher(value).matches()) return false;
        try {
            byte[] bytes = Base64.getUrlDecoder().decode(value);
            // The re-encoding check rejects non-canonical trailing bits (the last char carries 4 of them).
            return bytes.length == 32 && Base64.getUrlEncoder().withoutPadding().encodeToString(bytes).equals(value);
        } catch (IllegalArgumentException e) {
            return false;
        }
    }

    /** The pin of a certificate's public key. {@link X509Certificate#getPublicKey()} encodes as SubjectPublicKeyInfo. */
    static String of(X509Certificate certificate) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(sha256(certificate.getPublicKey().getEncoded()));
    }

    /** Whether {@code certificate}'s key has {@code pin}; false for a null certificate or a malformed pin. */
    static boolean matches(X509Certificate certificate, String pin) {
        if (certificate == null || !isPin(pin)) return false;
        return MessageDigest.isEqual(
                of(certificate).getBytes(StandardCharsets.US_ASCII), pin.getBytes(StandardCharsets.US_ASCII));
    }

    private static byte[] sha256(byte[] data) {
        try {
            return MessageDigest.getInstance("SHA-256").digest(data);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
