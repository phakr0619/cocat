package aichem.opsin;

import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.Base64;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

import uk.ac.cam.ch.wwmm.opsin.NameToStructure;
import uk.ac.cam.ch.wwmm.opsin.NameToStructureConfig;
import uk.ac.cam.ch.wwmm.opsin.OpsinResult;

/**
 * 名前 → 構造（OPSIN、規則で変換する）。Lambda の関数 URL（CloudFront の /api/opsin から呼ぶ）の受け口。
 *
 * 受け取る: POST、本文は名前を 1 行に 1 つ（text/plain、UTF-8）。最大 MAX_NAMES 個・1 つ MAX_LENGTH 文字。
 * 返す: {"results":[{"status":"SUCCESS|WARNING|FAILURE","smiles":"…","message":"…"}, …]}（名前と同じ順）。
 * 名前はログに残さない（数と秒数だけ）。JSON の部品を足さないよう、返す JSON は手で書く。
 */
public class OpsinHandler {
    static final int MAX_NAMES = 50;
    static final int MAX_LENGTH = 1000;

    static {
        // OPSIN は log4j の API で書く。出力の部品を入れていないので、警告を出さない簡単なものに替える
        System.setProperty("log4j2.loggerContextFactory", "org.apache.logging.log4j.simple.SimpleLoggerContextFactory");
    }

    // 規則のファイルを読み込むのに時間がかかるので、最初に 1 度だけ作る（SnapStart ではここまでを写しに入れる）
    private static final NameToStructure N2S = NameToStructure.getInstance();
    private static final NameToStructureConfig CONFIG = new NameToStructureConfig();

    static {
        // 名前に書いた立体を取りこぼしたら、そのことを知らせる（WARNING）
        CONFIG.setWarnRatherThanFailOnUninterpretableStereochemistry(true);
        CONFIG.setAllowRadicals(true);
        // 一度変換しておくと、最初の呼び出しが速い
        N2S.parseChemicalName("ethanol", CONFIG);
    }

    /** Lambda の関数 URL の受け口（イベントの形は payload 2.0） */
    public Map<String, Object> handleRequest(Map<String, Object> event) {
        long t0 = System.nanoTime();
        String method = methodOf(event);
        if (!"POST".equals(method)) return response(405, "{\"error\":\"POST で、名前を 1 行に 1 つ送ってください\"}");
        Object rawBody = event.get("body");
        String body = rawBody == null ? "" : rawBody.toString();
        if (Boolean.TRUE.equals(event.get("isBase64Encoded"))) body = new String(Base64.getDecoder().decode(body), StandardCharsets.UTF_8);
        List<String> names = splitNames(body);
        if (names.isEmpty()) return response(400, "{\"error\":\"名前がありません\"}");
        if (names.size() > MAX_NAMES) return response(400, "{\"error\":\"名前は一度に " + MAX_NAMES + " 個までです\"}");
        for (String n : names) if (n.length() > MAX_LENGTH) return response(400, "{\"error\":\"名前は 1 つ " + MAX_LENGTH + " 文字までです\"}");
        String json = convert(names);
        System.out.println("opsin names=" + names.size() + " ms=" + (System.nanoTime() - t0) / 1_000_000);
        return response(200, json);
    }

    /** 名前の並びを変換して、返す JSON にする */
    static String convert(List<String> names) {
        StringBuilder sb = new StringBuilder("{\"results\":[");
        for (int i = 0; i < names.size(); i++) {
            if (i > 0) sb.append(',');
            OpsinResult r = N2S.parseChemicalName(names.get(i), CONFIG);
            sb.append("{\"status\":\"").append(r.getStatus().name()).append('"');
            String smiles = r.getStatus() == OpsinResult.OPSIN_RESULT_STATUS.FAILURE ? null : r.getSmiles();
            if (smiles != null) sb.append(",\"smiles\":").append(quote(smiles));
            String message = r.getMessage();
            if (message != null && !message.isEmpty()) sb.append(",\"message\":").append(quote(message));
            sb.append('}');
        }
        return sb.append("]}").toString();
    }

    static List<String> splitNames(String body) {
        List<String> out = new ArrayList<>();
        for (String line : body.split("\r?\n")) {
            String t = line.trim();
            if (!t.isEmpty()) out.add(t);
        }
        return out;
    }

    @SuppressWarnings("unchecked")
    private static String methodOf(Map<String, Object> event) {
        Object ctx = event.get("requestContext");
        if (ctx instanceof Map) {
            Object http = ((Map<String, Object>) ctx).get("http");
            if (http instanceof Map) {
                Object m = ((Map<String, Object>) http).get("method");
                if (m != null) return m.toString();
            }
        }
        return "POST";
    }

    private static Map<String, Object> response(int status, String json) {
        Map<String, Object> headers = new LinkedHashMap<>();
        headers.put("content-type", "application/json; charset=utf-8");
        // 同じ名前は同じ構造になるので、ブラウザには少し覚えさせてよい（CloudFront では覚えない）
        headers.put("cache-control", status == 200 ? "private, max-age=3600" : "no-store");
        Map<String, Object> res = new LinkedHashMap<>();
        res.put("statusCode", status);
        res.put("headers", headers);
        res.put("body", json);
        return res;
    }

    static String quote(String s) {
        StringBuilder sb = new StringBuilder("\"");
        for (int i = 0; i < s.length(); i++) {
            char c = s.charAt(i);
            switch (c) {
                case '"': sb.append("\\\""); break;
                case '\\': sb.append("\\\\"); break;
                case '\n': sb.append("\\n"); break;
                case '\r': sb.append("\\r"); break;
                case '\t': sb.append("\\t"); break;
                default:
                    if (c < 0x20) sb.append(String.format("\\u%04x", (int) c));
                    else sb.append(c);
            }
        }
        return sb.append('"').toString();
    }

    /**
     * 手元で確かめるとき: 標準入力の名前（1 行に 1 つ）を変換して、JSON を標準出力に書く。
     * 例: printf 'ethanol\n(2S)-2-aminopropanoic acid\n' | java -jar target/opsin-lambda.jar
     */
    public static void main(String[] args) throws Exception {
        StringBuilder sb = new StringBuilder();
        try (BufferedReader in = new BufferedReader(new InputStreamReader(System.in, StandardCharsets.UTF_8))) {
            String line;
            while ((line = in.readLine()) != null) sb.append(line).append('\n');
        }
        System.out.println(convert(splitNames(sb.toString())));
    }
}
