import { describe, expect, it } from "bun:test";
import { REDACTED, redactString } from "./redaction.ts";

describe("redaction", () => {
  it("redacts Basic authorization headers in text", () => {
    const secret = "dXNlcjpzdXBlci1zZWNyZXQ=";
    const cases = [
      {
        input: `Authorization: Basic ${secret}`,
        output: `Authorization: Basic ${REDACTED}`,
      },
      {
        input: `{"Authorization":"Basic ${secret}"}`,
        output: `{"Authorization":"Basic ${REDACTED}"}`,
      },
      {
        input: `authorization=Basic ${secret}`,
        output: `authorization=Basic ${REDACTED}`,
      },
      {
        input: `{\\\"Authorization\\\":\\\"Basic ${secret}\\\"}`,
        output: `{\\\"Authorization\\\":\\\"Basic ${REDACTED}\\\"}`,
      },
      {
        input: `HTTP_AUTHORIZATION=Basic ${secret}`,
        output: `HTTP_AUTHORIZATION=Basic ${REDACTED}`,
      },
    ];

    for (const { input, output } of cases) {
      const result = redactString(input, "message");

      expect(result.value).toBe(output);
      expect(result.value).not.toContain(secret);
      expect(result.report).toMatchObject({
        applied: true,
        replacements: 1,
        fields: ["message:basic_auth"],
      });
    }
  });

  it("redacts URL userinfo credentials while preserving destination context", () => {
    const password = "super-secret";
    const result = redactString(
      `db=postgres://app:${password}@db.example:5432/logs?sslmode=require`,
      "message",
    );

    expect(result.value).toBe(
      `db=postgres://${REDACTED}@db.example:5432/logs?sslmode=require`,
    );
    expect(result.value).not.toContain(password);
    expect(result.report).toMatchObject({
      applied: true,
      replacements: 1,
      fields: ["message:url_userinfo"],
    });
  });
});
