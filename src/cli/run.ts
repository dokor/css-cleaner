import { realpath, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { parseArgs } from "node:util";
import type { DiscoveredProject, ExitCode, PolicyConfig, ReportFormat, ScanOutcome } from "../contracts.js";
import { CONFIG_FILE } from "../discovery/config.js";
import { getExitCode, renderReport } from "../reports/index.js";
import { scanProject, ScanProjectError } from "../scan/index.js";
import { resolvePolicy } from "../policy/index.js";
import { cliPolicy } from "./policy.js";

export interface CliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const help = `Usage: css-cleaner <commande> [options]

Audit local des classes CSS pour React, avec ou sans Next.js.

Commandes :
  scan [chemin]  Analyser un projet (répertoire courant par défaut)

Options :
  -h, --help     Afficher cette aide

Exemple :
  css-cleaner scan .
  css-cleaner scan --help

Le scan ne lance ni ne compile l’application analysée.
`;

const scanHelp = `Usage: css-cleaner scan [chemin] [options]

Audit des classes CSS, SCSS et Sass d’un projet React, avec ou sans Next.js.
Le chemin vaut . par défaut. Les sources sont lues sans exécuter l’application.
La configuration optionnelle est css-cleaner.config.json à la racine du projet.

Options :
  --format terminal|json|markdown  Format du rapport (défaut : terminal)
  --output <fichier>              Écrire le rapport dans un fichier au lieu de stdout
  --fail-on-missing               Code 1 si une classe manque avec confiance élevée
  --rule <catégorie>=<règle>      Gravité error|warning|info[:high|medium|low], ou off
  --require-complete             Code 1 si l’analyse est partielle
  --allow-partial                Accepter une analyse partielle (priorité sur le fichier)
  -h, --help                     Afficher cette aide

Le fichier de sortie est relatif au répertoire courant ; son parent doit exister.
Les sources analysées et css-cleaner.config.json ne peuvent pas être écrasés.
Les avertissements sont inclus dans le rapport, y compris en JSON.
--rule est répétable pour des catégories distinctes ; chaque gravité réactive la règle.
Catégories : unused-class, undefined-class, dynamic-usage, unresolved-import, analysis-warning.
Priorité : défauts < fichier policy < --fail-on-missing < options explicites.
--fail-on-missing et --rule undefined-class=... sont incompatibles.
--require-complete et --allow-partial sont incompatibles.
Le JSON reste le rapport brut v1 ; terminal et Markdown affichent la politique explicite.

Codes de sortie :
  0  Scan terminé (y compris usages dynamiques ou avertissements récupérables)
  1  Politique CI non satisfaite (règle bloquante ou analyse complète exigée)
  2  Arguments invalides, erreur de lecture, de configuration ou d’écriture

Exemples :
  css-cleaner scan .
  css-cleaner scan "./mon projet" --format json
  css-cleaner scan . --format markdown --output rapport.md
  css-cleaner scan . --format json --output rapport.json --fail-on-missing
  css-cleaner scan . --rule unused-class=error:high --require-complete
`;

interface ScanOptions {
  readonly rootDir: string;
  readonly format: ReportFormat;
  readonly outputFile?: string;
  readonly failOnMissing: boolean;
  readonly policy: PolicyConfig;
  readonly showPolicy: boolean;
  readonly help: boolean;
}

function scanOptions(args: readonly string[]): ScanOptions {
  const { values, positionals } = parseArgs({
    args: [...args],
    allowPositionals: true,
    strict: true,
    options: {
      format: { type: "string", default: "terminal" },
      output: { type: "string" },
      "fail-on-missing": { type: "boolean", default: false },
      rule: { type: "string", multiple: true },
      "require-complete": { type: "boolean", default: false },
      "allow-partial": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (positionals.length > 1) throw new Error("scan accepte un seul répertoire.");
  const format = values.format;
  if (format !== "terminal" && format !== "json" && format !== "markdown") {
    throw new Error(`Format inconnu : ${format}. Utilisez terminal, json ou markdown.`);
  }
  if (values.output !== undefined && (values.output.trim() === "" || values.output.includes("\0"))) {
    throw new Error("--output attend un chemin de fichier non vide, sans caractère NUL.");
  }
  const policy = cliPolicy(values.rule ?? [], values["require-complete"], values["allow-partial"], values["fail-on-missing"]);
  return {
    rootDir: positionals[0] ?? ".", format,
    ...(values.output === undefined ? {} : { outputFile: values.output }),
    failOnMissing: values["fail-on-missing"], help: values.help,
    policy, showPolicy: values.rule !== undefined || values["require-complete"] || values["allow-partial"],
  };
}

/** Protect inputs, including output paths that reach them through links. */
async function writeReport(file: string, content: string, project: DiscoveredProject): Promise<void> {
  try {
    const target = resolve(file);
    const root = await realpath(project.config.rootDir);
    let existing;
    try {
      existing = await stat(target);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    if (existing) {
      const canonicalTarget = await realpath(target);
      const inputs = [...project.styles, ...project.react, { file: CONFIG_FILE }];
      for (const input of inputs) {
        const source = resolve(root, input.file);
        let isInput = relative(source, canonicalTarget) === "";
        // A different path may still name the same file through a hard link.
        if (!isInput && existing.nlink > 1) {
          const info = await stat(source).catch((error: unknown) => {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
            throw error;
          });
          isInput = info !== undefined && info.dev === existing.dev && info.ino === existing.ino;
        }
        if (isInput) throw new Error(`Le fichier est une source ou configuration du projet : ${input.file}.`);
      }
    }
    await writeFile(target, content, "utf8");
  } catch (error) {
    throw new Error(`Impossible d’écrire le rapport ${JSON.stringify(file)} : ${errorMessage(error)}`, { cause: error });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function reportError(error: unknown, output: CliOutput, failOnMissing: boolean): ExitCode {
  const location = error instanceof ScanProjectError ? error.location : undefined;
  const outcome: ScanOutcome = {
    status: "error", reason: errorMessage(error),
    ...(location === undefined ? {} : { location }),
  };
  const context = location === undefined ? "" : `${location.file}:${location.line}${
    location.column === undefined ? "" : `:${location.column}`
  } : `;
  output.stderr(`Erreur : ${context}${outcome.reason}\n`);
  return getExitCode(outcome, { failOnMissing });
}

export async function runCli(args: readonly string[], output: CliOutput): Promise<ExitCode> {
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
    output.stdout(help);
    return 0;
  }
  if (args[0] === "scan") {
    let options: ScanOptions;
    try {
      options = scanOptions(args.slice(1));
    } catch (error) {
      return reportError(new Error(`${errorMessage(error)} Utilisez css-cleaner scan --help.`), output, false);
    }
    if (options.help) {
      output.stdout(scanHelp);
      return 0;
    }
    try {
      const { project, report } = await scanProject({ rootDir: options.rootDir });
      const policy = resolvePolicy(project.config.policy, options.policy, { failOnMissing: options.failOnMissing });
      const content = renderReport(report, options.format, options.showPolicy || project.config.policy !== undefined ? policy : undefined);
      if (options.outputFile === undefined) output.stdout(content);
      else await writeReport(options.outputFile, content, project);
      return getExitCode({ status: "success", report }, { policy });
    } catch (error) {
      return reportError(error, output, options.failOnMissing);
    }
  }
  output.stderr(`Commande ou option inconnue : ${args[0]}. Utilisez css-cleaner --help.\n`);
  return 2;
}
