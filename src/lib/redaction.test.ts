import { describe, expect, it } from "bun:test";
import { REDACTED, redactString, redactValue } from "./redaction.ts";

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

  it("redacts generic credential fields and assignments", () => {
    const secret = "plain-credential-value";
    const value = redactValue(
      {
        credentials: secret,
        nested: {
          clientCredentials: secret,
          safe: "kept",
        },
        argv: [
          "deploy",
          "--credentials",
          secret,
          "--clientCredentials",
          secret,
        ],
      },
      "metadata",
    );

    expect(JSON.stringify(value.value)).not.toContain(secret);
    expect(value.value).toMatchObject({
      credentials: REDACTED,
      nested: {
        clientCredentials: REDACTED,
        safe: "kept",
      },
      argv: [
        "deploy",
        "--credentials",
        REDACTED,
        "--clientCredentials",
        REDACTED,
      ],
    });
    expect(value.report).toMatchObject({
      applied: true,
      fields: [
        "metadata.credentials",
        "metadata.nested.clientCredentials",
        "metadata.argv[2]",
        "metadata.argv[4]",
      ],
      replacements: 4,
    });

    const result = redactString(
      [
        `credentials=${secret}`,
        `client_credential: '${secret}'`,
        `clientCredentials=${secret}`,
        `client_credentials=${secret}`,
        `?clientCredentials=${secret}`,
        `--credentials ${secret}`,
        `--clientCredentials ${secret}`,
      ].join(" "),
      "message",
    );

    expect(result.value).not.toContain(secret);
    expect(result.value).toContain(`credentials=${REDACTED}`);
    expect(result.value).toContain(`client_credential=${REDACTED}`);
    expect(result.value).toContain(`clientCredentials=${REDACTED}`);
    expect(result.value).toContain(`client_credentials=${REDACTED}`);
    expect(result.value).toContain(`?clientCredentials=${REDACTED}`);
    expect(result.value).toContain(`--credentials ${REDACTED}`);
    expect(result.value).toContain(`--clientCredentials ${REDACTED}`);
    expect(result.report).toMatchObject({
      applied: true,
      fields: [
        "message:secret_assignment",
        "message:secret_flag_argument",
        "message:secret_query_param",
      ],
      replacements: 7,
    });
  });

  it("does not infer split sensitive flags from ordinary credential words", () => {
    const result = redactValue(
      ["credentialed-user", "public-id-123"],
      "metadata.argv",
    );

    expect(result.value).toEqual(["credentialed-user", "public-id-123"]);
    expect(result.report).toMatchObject({
      applied: false,
      fields: [],
      replacements: 0,
    });

    const command = redactString(
      "--credentialed-user public-id-123",
      "message",
    );
    expect(command.value).toBe("--credentialed-user public-id-123");
    expect(command.report).toMatchObject({
      applied: false,
      fields: [],
      replacements: 0,
    });
  });

  it("preserves known non-secret fetch credentials modes", () => {
    const result = redactValue(
      {
        request: {
          credentials: "include",
          mode: "cors",
        },
        fallback: {
          credentials: "same-origin",
        },
        disabled: {
          credentials: "omit",
        },
      },
      "metadata",
    );

    expect(result.value).toEqual({
      request: {
        credentials: "include",
        mode: "cors",
      },
      fallback: {
        credentials: "same-origin",
      },
      disabled: {
        credentials: "omit",
      },
    });
    expect(result.report).toMatchObject({
      applied: false,
      fields: [],
      replacements: 0,
    });

    for (const input of [
      "fetch(url, { credentials: 'include' })",
      'fetch(url, { credentials: "same-origin" })',
      "fetch(url, { credentials: omit })",
    ]) {
      const text = redactString(input, "message");
      expect(text.value).toBe(input);
      expect(text.report).toMatchObject({
        applied: false,
        fields: [],
        replacements: 0,
      });
    }
  });
});
