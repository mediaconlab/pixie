import { describe, expect, it } from "vitest";
import { redact, REDACTED } from "../src/redact";

describe("redact", () => {
  it("redacts OpenAI/Anthropic style keys", () => {
    expect(redact("key sk-proj-abcdefghijklmnop1234 here")).toBe(`key ${REDACTED} here`);
    expect(redact("sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAA")).toBe(REDACTED);
  });

  it("redacts GitHub tokens", () => {
    expect(redact("ghp_0123456789abcdefghijABCDEFGHIJ012345")).toBe(REDACTED);
    expect(redact("token: github_pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz")).toBe(`token: ${REDACTED}`);
  });

  it("redacts AWS access key ids", () => {
    expect(redact("aws AKIAIOSFODNN7EXAMPLE end")).toBe(`aws ${REDACTED} end`);
  });

  it("redacts PEM private key blocks", () => {
    const pem = "-----BEGIN RSA PRIVATE KEY-----\nMIIEow\nAAAA\n-----END RSA PRIVATE KEY-----";
    expect(redact(`before\n${pem}\nafter`)).toBe(`before\n${REDACTED}\nafter`);
    const ossh = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3Bl\n-----END OPENSSH PRIVATE KEY-----";
    expect(redact(ossh)).toBe(REDACTED);
    expect(redact("-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----")).toBe(REDACTED);
  });

  it("does not touch public keys / certificates", () => {
    const pub = "-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----";
    expect(redact(pub)).toBe(pub);
  });

  it("redacts quoted password/secret/token assignments", () => {
    expect(redact('password = "hunter2"')).toBe(`password = "${REDACTED}"`);
    expect(redact("const apiToken = 'abc123';")).toBe(`const apiToken = '${REDACTED}';`);
    expect(redact('{ "client_secret": "xyz" }')).toBe(`{ "client_secret": "${REDACTED}" }`);
    expect(redact("DB_PASSWORD: `p@ss`")).toBe(`DB_PASSWORD: \`${REDACTED}\``);
    expect(redact('api_key="k"')).toBe(`api_key="${REDACTED}"`);
  });

  it("redacts unquoted env style values", () => {
    expect(redact("export GITHUB_TOKEN=abc123\nNAME=pixie")).toBe(`export GITHUB_TOKEN=${REDACTED}\nNAME=pixie`);
  });

  it("leaves ordinary code alone", () => {
    const code = 'const tokens = tokenize(input);\nif (password.length < 8) throw new Error("too short");\nconst sk = 1;';
    expect(redact(code)).toBe(code);
  });

  it("is idempotent", () => {
    const once = redact('secret = "x" sk-abcdefghijklmnopqrstu');
    expect(redact(once)).toBe(once);
  });
});
