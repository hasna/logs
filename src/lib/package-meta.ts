import { existsSync, readFileSync } from "node:fs"

type StandaloneCliSpec = {
  name: string
  description: string
  options?: string[]
}

type PackageJson = {
  version?: string
}

const PACKAGE_JSON_CANDIDATES = [
  "../../package.json",
  "../package.json",
  "./package.json",
]

function readPackageJson(baseUrl: string | URL = import.meta.url): PackageJson {
  // Bundled shared chunks live under dist/, while source modules live under src/lib/.
  for (const relativePath of PACKAGE_JSON_CANDIDATES) {
    const candidate = new URL(relativePath, baseUrl)
    if (!existsSync(candidate)) continue

    return JSON.parse(readFileSync(candidate, "utf8")) as PackageJson
  }

  throw new Error(`Unable to locate package.json from ${String(baseUrl)}`)
}

export function readPackageVersion(baseUrl: string | URL = import.meta.url): string {
  return readPackageJson(baseUrl).version ?? "0.0.0"
}

export const PACKAGE_VERSION = readPackageVersion()

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
