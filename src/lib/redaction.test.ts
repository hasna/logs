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

  it("redacts cookie headers in plain text and serialized header maps", () => {
    const secret = "session-secret-12345";
    const cases = [
      {
        input: `Cookie: sid=${secret}; theme=dark`,
        output: `Cookie: ${REDACTED}`,
      },
      {
        input: `Set-Cookie: sid=${secret}; HttpOnly; Secure`,
        output: `Set-Cookie: ${REDACTED}`,
      },
      {
        input: `cookie=sid=${secret}; theme=dark`,
        output: `cookie=${REDACTED}`,
      },
      {
        input: `{"cookie":"sid=${secret}; theme=dark"}`,
        output: `{"cookie":"${REDACTED}"}`,
      },
      {
        input: `{"set-cookie":"sid=\\"${secret}\\"; HttpOnly"}`,
        output: `{"set-cookie":"${REDACTED}"}`,
      },
      {
        input: `{\\\"set-cookie\\\":\\\"sid=${secret}; HttpOnly\\\"}`,
        output: `{\\\"set-cookie\\\":\\\"${REDACTED}\\\"}`,
      },
      {
        input: `{\\\"set-cookie\\\":\\\"sid=\\\\\\\"${secret}\\\\\\\"; HttpOnly\\\"}`,
        output: `{\\\"set-cookie\\\":\\\"${REDACTED}\\\"}`,
      },
      {
        input: `{"set-cookie":["sid=${secret}; HttpOnly"]}`,
        output: `{"set-cookie":["${REDACTED}"]}`,
      },
      {
        input: `{"set-cookie":["sid=\\"${secret}\\"; HttpOnly"]}`,
        output: `{"set-cookie":["${REDACTED}"]}`,
      },
      {
        input: `{"headers":{"cookie":["sid=${secret}; theme=dark"]}}`,
        output: `{"headers":{"cookie":["${REDACTED}"]}}`,
      },
      {
        input: `[["cookie","sid=${secret}; theme=dark"]]`,
        output: `[["cookie","${REDACTED}"]]`,
      },
      {
        input: `[["cookie","sid=\\"${secret}\\"; theme=dark"]]`,
        output: `[["cookie","${REDACTED}"]]`,
      },
      {
        input: `Cookie: sid=abc]${secret}; theme=dark`,
        output: `Cookie: ${REDACTED}`,
      },
      {
        input: `Set-Cookie: sid=abc}${secret}; HttpOnly`,
        output: `Set-Cookie: ${REDACTED}`,
      },
    ];

    for (const { input, output } of cases) {
      const result = redactString(input, "message");

      expect(result.value).toBe(output);
      expect(result.value).not.toContain(secret);
      expect(result.report).toMatchObject({
        applied: true,
        replacements: 1,
        fields: ["message:cookie_header"],
      });
    }

    const publicText = redactString("cookie banner accepted", "message");
    expect(publicText.value).toBe("cookie banner accepted");
    expect(publicText.report).toMatchObject({
      applied: false,
      fields: [],
      replacements: 0,
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

  it("redacts sensitive structured name/value pairs", () => {
    const cookieSecret = "structured-cookie-secret";
    const setCookieSecret = "structured-set-cookie-secret";
    const apiKeySecret = "structured-api-key-secret";
    const result = redactValue(
      {
        headers: [
          { name: "Cookie", value: `sid=${cookieSecret}; theme=dark` },
          { key: "set-cookie", value: `refresh=${setCookieSecret}; HttpOnly` },
          { header: "x-api-key", values: [apiKeySecret] },
          { name: "content-type", value: "application/json" },
        ],
        options: [{ name: "credentials", value: "include" }],
      },
      "metadata",
    );

    expect(JSON.stringify(result.value)).not.toContain(cookieSecret);
    expect(JSON.stringify(result.value)).not.toContain(setCookieSecret);
    expect(JSON.stringify(result.value)).not.toContain(apiKeySecret);
    expect(result.value).toEqual({
      headers: [
        { name: "Cookie", value: REDACTED },
        { key: "set-cookie", value: REDACTED },
        { header: "x-api-key", values: REDACTED },
        { name: "content-type", value: "application/json" },
      ],
      options: [{ name: "credentials", value: "include" }],
    });
    expect(result.report).toMatchObject({
      applied: true,
      fields: [
        "metadata.headers[0].value",
        "metadata.headers[1].value",
        "metadata.headers[2].values",
      ],
      replacements: 3,
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
