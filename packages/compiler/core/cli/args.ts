import { expandConfigVariables } from "../../config/config-interpolation.js";
import { loadCadlConfigForPath, validateConfigPathsAbsolute } from "../../config/config-loader.js";
import { CadlConfig } from "../../config/types.js";
import { createDiagnosticCollector } from "../index.js";
import { CompilerOptions } from "../options.js";
import { resolvePath } from "../path-utils.js";
import { CompilerHost, Diagnostic } from "../types.js";
import { omitUndefined } from "../util.js";

export interface CompileCliArgs {
  "output-dir"?: string;
  "output-path"?: string;
  nostdlib?: boolean;
  options?: string[];
  import?: string[];
  watch?: boolean;
  emit?: string[];
  trace?: string[];
  debug?: boolean;
  "warn-as-error"?: boolean;
  "no-emit"?: boolean;
  args?: string[];
}

export async function getCompilerOptions(
  host: CompilerHost,
  cwd: string,
  args: CompileCliArgs,
  env: Record<string, string | undefined>
): Promise<[CompilerOptions | undefined, readonly Diagnostic[]]> {
  const diagnostics = createDiagnosticCollector();
  const pathArg = args["output-dir"] ?? args["output-path"];

  const config = await loadCadlConfigForPath(host, cwd);
  if (config.diagnostics.length > 0) {
    if (config.diagnostics.some((d) => d.severity === "error")) {
      return [undefined, config.diagnostics];
    }
    config.diagnostics.forEach((x) => diagnostics.add(x));
  }

  const cliOptions = resolveOptions(args);

  const configWithCliArgs: CadlConfig = {
    ...config,
    outputDir: config.outputDir,
    imports: args["import"] ?? config["imports"],
    warnAsError: args["warn-as-error"] ?? config.warnAsError,
    trace: args.trace ?? config.trace,
    emitters: resolveEmitters(config, cliOptions, args),
  };
  const cliOutputDir = pathArg ? resolvePath(cwd, pathArg) : undefined;

  const expandedConfig = diagnostics.pipe(
    expandConfigVariables(configWithCliArgs, {
      cwd: cwd,
      outputDir: cliOutputDir,
      env,
      args: resolveConfigArgs(args),
    })
  );
  validateConfigPathsAbsolute(expandedConfig).forEach((x) => diagnostics.add(x));

  const options: CompilerOptions = omitUndefined({
    nostdlib: args["nostdlib"],
    watchForChanges: args["watch"],
    noEmit: args["no-emit"],
    miscOptions: cliOptions.miscOptions,

    outputDir: expandedConfig.outputDir,
    additionalImports: expandedConfig["imports"],
    warningAsError: expandedConfig.warnAsError,
    trace: expandedConfig.trace,
    emitters: expandedConfig.emitters,
  });
  return diagnostics.wrap(options);
}

function resolveConfigArgs(args: CompileCliArgs): Record<string, string> {
  const map: Record<string, string> = {};
  for (const arg of args.args ?? []) {
    const optionParts = arg.split("=");
    if (optionParts.length !== 2) {
      throw new Error(`The --arg parameter value "${arg}" must be in the format: arg-name=value`);
    }

    map[optionParts[0]] = optionParts[1];
  }

  return map;
}
function resolveOptions(
  args: CompileCliArgs
): Record<string | "miscOptions", Record<string, unknown>> {
  const options: Record<string, Record<string, string>> = {};
  for (const option of args.options ?? []) {
    const optionParts = option.split("=");
    if (optionParts.length !== 2) {
      throw new Error(
        `The --option parameter value "${option}" must be in the format: <emitterName>.some-options=value`
      );
    }
    const optionKeyParts = optionParts[0].split(".");
    if (optionKeyParts.length === 1) {
      const key = optionKeyParts[0];
      if (!("miscOptions" in options)) {
        options.miscOptions = {};
      }
      options.miscOptions[key] = optionParts[1];
    } else if (optionKeyParts.length > 2) {
      throw new Error(
        `The --option parameter value "${option}" must be in the format: <emitterName>.some-options=value`
      );
    }
    const emitterName = optionKeyParts[0];
    const key = optionKeyParts[1];
    if (!(emitterName in options)) {
      options[emitterName] = {};
    }
    options[emitterName][key] = optionParts[1];
  }
  return options;
}

function resolveEmitters(
  config: CadlConfig,
  options: Record<string | "miscOptions", Record<string, unknown>>,
  args: CompileCliArgs
): Record<string, Record<string, unknown>> {
  const emitters = resolveSelectedEmittersFromConfig(config, args.emit);

  const configuredEmitters: Record<string, Record<string, unknown>> = {};

  for (const [emitterName, emitterConfig] of Object.entries(emitters)) {
    const cliOptionOverride = options[emitterName];

    if (cliOptionOverride) {
      configuredEmitters[emitterName] = {
        ...emitterConfig,
        ...cliOptionOverride,
      };
    } else {
      configuredEmitters[emitterName] = emitterConfig;
    }
  }

  return configuredEmitters;
}

function resolveSelectedEmittersFromConfig(
  config: CadlConfig,
  selectedEmitters: string[] | undefined
): Record<string, Record<string, unknown>> {
  if (selectedEmitters) {
    const emitters: Record<string, Record<string, unknown>> = {};
    for (const emitter of selectedEmitters) {
      emitters[emitter] = config.emitters[emitter] ?? {};
    }
    return emitters;
  }
  return config.emitters;
}