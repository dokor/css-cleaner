export interface CliOutput {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

const help = `Usage: css-cleaner <commande> [options]

Audit local des classes CSS pour React, avec ou sans Next.js.

Commandes :
  scan [chemin]  Analyser un projet (à venir ; commande réservée)

Options :
  -h, --help     Afficher cette aide

Ce socle ne lance ni ne compile l’application analysée.
`;

const scanHelp = `Usage: css-cleaner scan [chemin]

Future commande d’audit des classes CSS, SCSS et Sass d’un projet React.
Les parseurs, le rapprochement et le branchement de scan seront ajoutés
dans les tickets suivants. Aucun audit n’est encore effectué.
`;

export function runCli(args: readonly string[], output: CliOutput): number {
  if (args.length === 0 || (args.length === 1 && (args[0] === "--help" || args[0] === "-h"))) {
    output.stdout(help);
    return 0;
  }
  if (args[0] === "scan") {
    if (args.length === 2 && (args[1] === "--help" || args[1] === "-h")) {
      output.stdout(scanHelp);
      return 0;
    }
    output.stderr("La commande scan n’est pas encore implémentée (socle de l’issue #1).\n");
    return 2;
  }
  output.stderr(`Commande ou option inconnue : ${args[0]}. Utilisez css-cleaner --help.\n`);
  return 2;
}
