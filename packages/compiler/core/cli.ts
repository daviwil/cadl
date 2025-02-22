import { spawnSync, SpawnSyncOptionsWithStringEncoding } from "child_process";
import { mkdtemp, readdir, rmdir } from "fs/promises";
import mkdirp from "mkdirp";
import watch from "node-watch";
import os from "os";
import { basename, extname, join, resolve } from "path";
import url from "url";
import yargs from "yargs";
import { loadCadlConfigInDir } from "../config/index.js";
import { CompilerOptions } from "../core/options.js";
import { compile, Program } from "../core/program.js";
import { compilerAssert, dumpError, logDiagnostics } from "./diagnostics.js";
import { formatCadlFiles } from "./formatter.js";
import { initCadlProject } from "./init.js";
import { cadlVersion, NodeHost } from "./util.js";

async function main() {
  console.log(`Cadl compiler v${cadlVersion}\n`);

  await yargs(process.argv.slice(2))
    .scriptName("cadl")
    .help()
    .strict()
    .option("debug", {
      type: "boolean",
      description: "Output debug log messages.",
      default: false,
    })
    .command(
      "compile <path>",
      "Compile Cadl source.",
      (cmd) => {
        return cmd
          .positional("path", {
            description: "The path to the main.cadl file or directory containing main.cadl.",
            type: "string",
            demandOption: true,
          })
          .option("output-path", {
            type: "string",
            default: "./cadl-output",
            describe:
              "The output path for generated artifacts.  If it does not exist, it will be created.",
          })
          .option("option", {
            type: "array",
            string: true,
            describe:
              "Key/value pairs that can be passed to Cadl components.  The format is 'key=value'.  This parameter can be used multiple times to add more options.",
          })
          .option("nostdlib", {
            type: "boolean",
            default: false,
            describe: "Don't load the Cadl standard library.",
          })
          .option("watch", {
            type: "boolean",
            default: false,
            describe: "Watch project files for changes and recompile.",
          });
      },
      async (args) => {
        const options = await getCompilerOptions(args);
        await compileInput(args.path, options);
      }
    )
    .command("code", "Manage VS Code Extension.", (cmd) => {
      return cmd
        .demandCommand(1, "No command specified.")
        .option("insiders", {
          type: "boolean",
          description: "Use VS Code Insiders",
          default: false,
        })
        .command(
          "install",
          "Install VS Code Extension",
          () => {},
          (args) => installVSCodeExtension(args.insiders, args.debug)
        )
        .command(
          "uninstall",
          "Uninstall VS Code Extension",
          () => {},
          (args) => uninstallVSCodeExtension(args.insiders, args.debug)
        );
    })
    .command("vs", "Manage Visual Studio Extension.", (cmd) => {
      return cmd
        .demandCommand(1, "No command specified")
        .command(
          "install",
          "Install Visual Studio Extension.",
          () => {},
          (args) => installVSExtension(args.debug)
        )
        .command(
          "uninstall",
          "Uninstall VS Extension",
          () => {},
          () => uninstallVSExtension()
        );
    })
    .command(
      "format <include...>",
      "Format given list of Cadl files.",
      (cmd) => {
        return cmd.positional("include", {
          description: "Wildcard pattern of the list of files.",
          type: "string",
          array: true,
          demandOption: true,
        });
      },
      async (args) => {
        await formatCadlFiles(args["include"], { debug: args.debug });
      }
    )
    .command(
      "init [templatesUrl]",
      "Create a new Cadl project.",
      (cmd) =>
        cmd.positional("templatesUrl", {
          description: "Url of the initialization template",
          type: "string",
        }),
      (args) => initCadlProject(NodeHost, process.cwd(), args.templatesUrl)
    )
    .command(
      "info",
      "Show information about current Cadl compiler.",
      () => {},
      () => printInfo()
    )
    .version(cadlVersion)
    .demandCommand(1, "You must use one of the supported commands.").argv;
}

function compileInput(
  path: string,
  compilerOptions: CompilerOptions,
  printSuccess = true
): Promise<Program> {
  let compileRequested: boolean = false;
  let currentCompilePromise: Promise<Program> | undefined = undefined;

  let log = (message?: any, ...optionalParams: any[]) => {
    let prefix = compilerOptions.watchForChanges ? `[${new Date().toLocaleTimeString()}] ` : "";
    console.log(`${prefix}${message}`, ...optionalParams);
  };

  let runCompile = () => {
    // Don't run the compiler if it's already running
    if (!currentCompilePromise) {
      // Clear the console before compiling in watch mode
      if (compilerOptions.watchForChanges) {
        console.clear();
      }

      currentCompilePromise = compile(path, NodeHost, compilerOptions).then(onCompileFinished);
    } else {
      compileRequested = true;
    }

    return currentCompilePromise;
  };

  let onCompileFinished = (program: Program) => {
    if (program.diagnostics.length > 0) {
      log("Diagnostics were reported during compilation:\n");
      logDiagnostics(program.diagnostics, NodeHost.logSink);
    } else {
      if (printSuccess) {
        log(
          `Compilation completed successfully, output files are in ${compilerOptions.outputPath}.`
        );
      }
    }

    console.log(); // Insert a newline
    currentCompilePromise = undefined;
    if (compilerOptions.watchForChanges && compileRequested) {
      compileRequested = false;
      runCompile();
    }

    return program;
  };

  if (compilerOptions.watchForChanges) {
    runCompile();
    return new Promise((resolve, reject) => {
      const watcher = watch(
        path,
        {
          recursive: true,
          filter: (f) => [".js", ".cadl"].indexOf(extname(f)) > -1 && !/node_modules/.test(f),
        },
        (e, name) => {
          runCompile();
        }
      );

      // Handle Ctrl+C for termination
      process.on("SIGINT", () => {
        watcher.close();
        console.info("Terminating watcher...\n");
      });
    });
  } else {
    return runCompile();
  }
}

async function getCompilerOptions(args: {
  "output-path": string;
  nostdlib?: boolean;
  option?: string[];
  watch?: boolean;
}): Promise<CompilerOptions> {
  // Ensure output path
  const outputPath = resolve(args["output-path"]);
  await mkdirp(outputPath);

  const miscOptions: any = {};
  for (const option of args.option || []) {
    const optionParts = option.split("=");
    if (optionParts.length != 2) {
      throw new Error(
        `The --option parameter value "${option}" must be in the format: some-option=value`
      );
    }
    miscOptions[optionParts[0]] = optionParts[1];
  }

  return {
    miscOptions,
    outputPath,
    swaggerOutputFile: resolve(args["output-path"], "openapi.json"),
    nostdlib: args["nostdlib"],
    watchForChanges: args["watch"],
  };
}

async function installVsix(pkg: string, install: (vsixPaths: string[]) => void, debug: boolean) {
  // download npm package to temporary directory
  const temp = await mkdtemp(join(os.tmpdir(), "cadl"));
  const npmArgs = ["install"];

  // hide npm output unless --debug was passed to cadl
  if (!debug) {
    npmArgs.push("--silent");
  }

  // NOTE: Using cwd=temp with `--prefix .` instead of `--prefix ${temp}` to
  // workaround https://github.com/npm/cli/issues/3256. It's still important
  // to pass --prefix even though we're using cwd as otherwise, npm might
  // find a package.json file in a parent directory and install to that
  // directory.
  npmArgs.push("--prefix", ".");

  // To debug with a locally built package rather than pulling from npm,
  // specify the full path to the packed .tgz using CADL_DEBUG_VSIX_TGZ
  // environment variable.
  npmArgs.push(process.env.CADL_DEBUG_VSIX_TGZ ?? pkg);

  run("npm", npmArgs, { cwd: temp, debug });

  // locate .vsix
  const dir = join(temp, "node_modules", pkg);
  const files = await readdir(dir);
  let vsixPaths: string[] = [];
  for (const file of files) {
    if (file.endsWith(".vsix")) {
      vsixPaths.push(join(dir, file));
    }
  }

  compilerAssert(
    vsixPaths.length > 0,
    `Installed ${pkg} from npm, but didn't find any .vsix files in it.`
  );

  // install extension
  install(vsixPaths);

  // delete temporary directory
  await rmdir(temp, { recursive: true });
}

async function runCode(codeArgs: string[], insiders: boolean, debug: boolean) {
  await run(insiders ? "code-insiders" : "code", codeArgs, {
    // VS Code's CLI emits node warnings that we can't do anything about. Suppress them.
    extraEnv: { NODE_NO_WARNINGS: "1" },
    debug,
  });
}

async function installVSCodeExtension(insiders: boolean, debug: boolean) {
  await installVsix(
    "cadl-vscode",
    (vsixPaths) => {
      runCode(["--install-extension", vsixPaths[0]], insiders, debug);
    },
    debug
  );
}

async function uninstallVSCodeExtension(insiders: boolean, debug: boolean) {
  await runCode(["--uninstall-extension", "microsoft.cadl-vscode"], insiders, debug);
}

function getVsixInstallerPath(): string {
  return getVSInstallerPath(
    "resources/app/ServiceHub/Services/Microsoft.VisualStudio.Setup.Service/VSIXInstaller.exe"
  );
}

function getVSWherePath(): string {
  return getVSInstallerPath("vswhere.exe");
}

function getVSInstallerPath(relativePath: string) {
  if (process.platform !== "win32") {
    console.error("error: Visual Studio extension is not supported on non-Windows.");
    process.exit(1);
  }

  return join(
    process.env["ProgramFiles(x86)"] ?? "",
    "Microsoft Visual Studio/Installer",
    relativePath
  );
}

function isVSInstalled(versionRange: string) {
  const vswhere = getVSWherePath();
  const proc = run(vswhere, ["-property", "instanceid", "-prerelease", "-version", versionRange], {
    stdio: [null, "pipe", "inherit"],
    allowNotFound: true,
  });
  return proc.status === 0 && proc.stdout;
}

const VSIX_ALREADY_INSTALLED = 1001;
const VSIX_NOT_INSTALLED = 1002;
const VSIX_USER_CANCELED = 2005;

async function installVSExtension(debug: boolean) {
  const vsixInstaller = getVsixInstallerPath();
  const versionMap = new Map([
    [
      "Microsoft.Cadl.VS2019.vsix",
      {
        friendlyVersion: "2019",
        versionRange: "[16.0, 17.0)",
        installed: false,
      },
    ],
    [
      "Microsoft.Cadl.VS2022.vsix",
      {
        friendlyVersion: "2022",
        versionRange: "[17.0, 18.0)",
        installed: false,
      },
    ],
  ]);

  let vsFound = false;
  for (const entry of versionMap.values()) {
    if (isVSInstalled(entry.versionRange)) {
      vsFound = entry.installed = true;
    }
  }

  if (!vsFound) {
    console.error("error: No compatible version of Visual Studio found.");
    process.exit(1);
  }

  await installVsix(
    "cadl-vs",
    (vsixPaths) => {
      for (const vsix of vsixPaths) {
        const vsixFilename = basename(vsix);
        const entry = versionMap.get(vsixFilename);
        compilerAssert(entry, "Unexpected vsix filename:" + vsix);
        if (entry.installed) {
          console.log(`Installing extension for Visual Studio ${entry?.friendlyVersion}...`);
          run(vsixInstaller, [vsix], {
            allowedExitCodes: [VSIX_ALREADY_INSTALLED, VSIX_USER_CANCELED],
          });
        }
      }
    },
    debug
  );
}

async function uninstallVSExtension() {
  const vsixInstaller = getVsixInstallerPath();
  run(vsixInstaller, ["/uninstall:88b9492f-c019-492c-8aeb-f325a7e4cf23"], {
    allowedExitCodes: [VSIX_NOT_INSTALLED, VSIX_USER_CANCELED],
  });
}

/**
 * Print the resolved Cadl configuration.
 */
async function printInfo() {
  const cwd = process.cwd();
  console.log(`Module: ${url.fileURLToPath(import.meta.url)}`);

  const config = await loadCadlConfigInDir(NodeHost, cwd);
  const jsyaml = await import("js-yaml");
  const excluded = ["diagnostics", "filename"];
  const replacer = (key: string, value: any) => (excluded.includes(key) ? undefined : value);

  console.log(`User Config: ${config.filename ?? "No config file found"}`);
  console.log("-----------");
  console.log(jsyaml.dump(config, { replacer }));
  console.log("-----------");
  logDiagnostics(config.diagnostics, NodeHost.logSink);
  if (config.diagnostics.some((d) => d.severity === "error")) {
    process.exit(1);
  }
}

// NOTE: We could also use { shell: true } to let windows find the .cmd, but that breaks
// ENOENT checking and handles spaces poorly in some cases.
const isCmdOnWindows = ["code", "code-insiders", "npm"];

interface RunOptions extends Partial<SpawnSyncOptionsWithStringEncoding> {
  debug?: boolean;
  extraEnv?: NodeJS.ProcessEnv;
  allowNotFound?: boolean;
  allowedExitCodes?: number[];
}

function run(command: string, commandArgs: string[], options?: RunOptions) {
  if (options?.debug) {
    if (options) {
      console.log(options);
    }
    console.log(`> ${command} ${commandArgs.join(" ")}\n`);
  }

  if (options?.extraEnv) {
    options.env = {
      ...(options?.env ?? process.env),
      ...options.extraEnv,
    };
  }

  const baseCommandName = basename(command);
  if (process.platform === "win32" && isCmdOnWindows.includes(command)) {
    command += ".cmd";
  }

  const finalOptions: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf-8",
    stdio: "inherit",
    ...(options ?? {}),
  };

  const proc = spawnSync(command, commandArgs, finalOptions);
  if (options?.debug) {
    console.log(proc);
  }

  if (proc.error) {
    if ((proc.error as any).code === "ENOENT" && !options?.allowNotFound) {
      console.error(`error: Command '${baseCommandName}' not found.`);
      if (options?.debug) {
        console.log(proc.error.stack);
      }
      process.exit(1);
    } else {
      throw proc.error;
    }
  }

  if (proc.status !== 0 && !options?.allowedExitCodes?.includes(proc.status ?? 0)) {
    console.error(
      `error: Command '${baseCommandName} ${commandArgs.join(" ")}' failed with exit code ${
        proc.status
      }.`
    );
    process.exit(proc.status || 1);
  }

  return proc;
}

function internalCompilerError(error: Error) {
  // NOTE: An expected error, like one thrown for bad input, shouldn't reach
  // here, but be handled somewhere else. If we reach here, it should be
  // considered a bug and therefore we should not suppress the stack trace as
  // that risks losing it in the case of a bug that does not repro easily.
  console.error("Internal compiler error!");
  console.error("File issue at https://github.com/azure/adl");
  dumpError(error, NodeHost.logSink);
  process.exit(1);
}

process.on("unhandledRejection", (error: Error) => {
  console.error("Unhandled promise rejection!");
  internalCompilerError(error);
});

main().catch(internalCompilerError);
