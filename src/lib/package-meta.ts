import { readFileSync } from "node:fs"

type StandaloneCliSpec = {
  name: string
  description: string
  options?: string[]
}

type PackageJson = {
  version?: string
}

const packageJson = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
) as PackageJson

export const PACKAGE_VERSION = packageJson.version ?? "0.0.0"

export function exitIfMetadataRequest(spec: StandaloneCliSpec, argv = process.argv.slice(2)): void {
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(PACKAGE_VERSION)
    process.exit(0)
  }

  if (argv.includes("--help") || argv.includes("-h")) {
    const options = spec.options ?? []
    const renderedOptions = [
      "  -V, --version  output the version number",
      "  -h, --help     display help for command",
      ...options,
    ]

    console.log(
      [
        `Usage: ${spec.name} [options]`,
        "",
        spec.description,
        "",
        "Options:",
        ...renderedOptions,
      ].join("\n"),
    )
    process.exit(0)
  }
}

export function readOptionValue(names: string[], argv = process.argv.slice(2)): string | undefined {
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (!arg) continue

    const inline = names.find((name) => arg.startsWith(`${name}=`))
    if (inline) return arg.slice(inline.length + 1)

    if (names.includes(arg)) {
      const next = argv[index + 1]
      if (next && !next.startsWith("-")) return next
    }
  }

  return undefined
}
