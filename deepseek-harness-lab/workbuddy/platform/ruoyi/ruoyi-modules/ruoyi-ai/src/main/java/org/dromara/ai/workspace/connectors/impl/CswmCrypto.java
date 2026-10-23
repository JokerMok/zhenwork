package org.dromara.ai.workspace.connectors.impl;

import cn.hutool.core.util.HexUtil;
import cn.hutool.crypto.SmUtil;
import cn.hutool.crypto.symmetric.SM4;
import org.dromara.common.json.utils.JsonUtils;
import org.dromara.ai.workspace.connectors.ConnectorException;

import java.security.SecureRandom;
import java.time.Clock;
import java.util.LinkedHashMap;
import java.util.Map;

final class CswmCrypto {
    private static final SecureRandom RANDOM = new SecureRandom();

    private CswmCrypto() {
    }

    static Map<String, Object> request(Map<String, Object> params, String token, Clock clock) {
        requireToken(token);
        String data;
        try {
            SM4 sm4 = new SM4(HexUtil.decodeHex(token));
            data = sm4.encryptHex(JsonUtils.toJsonString(params == null ? Map.of() : params));
        } catch (RuntimeException e) {
            throw new ConnectorException(400, "ConnectorCredentialInvalid", "CSWM token format is invalid");
        }
        byte[] nonceBytes = new byte[16];
        RANDOM.nextBytes(nonceBytes);
        String nonce = HexUtil.encodeHexStr(nonceBytes);
        String timestamp = Long.toString(clock.instant().getEpochSecond());
        String sign = SmUtil.sm3("data=" + data + "&nonce=" + nonce + "&timestamp=" + timestamp).toUpperCase(java.util.Locale.ROOT);
        var body = new LinkedHashMap<String, Object>();
        body.put("data", data);
        body.put("nonce", nonce);
        body.put("timestamp", timestamp);
        body.put("sign", sign);
        return body;
    }

    static void requireToken(String token) {
        if (token == null || !token.matches("[0-9a-fA-F]{32}")) {
            throw new ConnectorException(400, "ConnectorCredentialInvalid", "CSWM token format is invalid");
        }
    }
}
