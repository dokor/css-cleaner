# CSS Cleaner

CSS Cleaner est un projet de CLI qui aide à nettoyer progressivement les styles d’une application React, avec ou sans Next.js. Son objectif est de repérer les classes probablement inutilisées et les références à des styles manquants, puis d’indiquer où vérifier chaque résultat avant de modifier le code.

**État du projet** — La commande `css-cleaner scan` relie la découverte, les analyseurs CSS/Sass et JSX, le rapprochement et les rapports. La validation sur des projets témoins Next.js et Vite reste prévue dans [l’issue #8](https://github.com/dokor/css-cleaner/issues/8). [Suivre l’avancement sur GitHub](https://github.com/dokor/css-cleaner/issues/9).

Les lectures de CSS Modules via une variable intermédiaire sont conservées.
Les déclarations `composes` produisent un avertissement qui réduit la confiance
des classes dans les portées concernées. Une origine indéterminée, comme un chemin
interpolé, rend l’analyse incertaine à l’échelle du projet.

## Ce que l’outil analyse

- **Styles** — CSS, SCSS et Sass indenté, en fichiers globaux ou en CSS Modules (`.module.css`, `.module.scss`, `.module.sass`). L’analyse couvre les sélecteurs composés et les variantes BEM imbriquées.
- **Composants React** — Classes écrites dans `className`, accès comme `styles.title`, conditions, appels à `clsx` ou `classnames` et chaînes de caractères interpolées.
- **Portée des noms** — Une référence à `styles.title` est recherchée dans le module importé par le composant. Une classe homonyme dans un autre module ne peut pas masquer une faute.

## Exemple de diagnostic

Si un composant construit une classe avec `button--${variant}`, l’analyse rapproche ce motif de `.button--primary` et `.button--secondary`. Le rapport les présente comme des candidates à vérifier. À l’inverse, si le composant lit `styles.primray` et que son module déclare seulement `.primary`, le rapport signale l’accès manquant et sa ligne dans le composant.

## Utilisation

Lancer `css-cleaner scan .` depuis la racine du projet, ou passer un autre répertoire. Sans chemin, `scan` analyse le répertoire courant. Les sources sont lues sans démarrer de serveur, exécuter la configuration applicative ni compiler l’application. Seule la configuration déclarative optionnelle [`css-cleaner.config.json`](src/discovery/README.md) est chargée.

```sh
css-cleaner scan .
css-cleaner scan "./mon projet" --format json
css-cleaner scan . --format markdown --output rapport.md
css-cleaner scan . --format json --output rapport.json --fail-on-missing
```

Le format par défaut est `terminal` ; `--format` accepte aussi `json` et `markdown`.
Sans `--output`, seul le rapport est écrit sur stdout : le JSON se parse directement.
Avec `--output <fichier>`, le rapport est écrit en UTF-8 dans ce fichier et stdout reste
vide. Un chemin de sortie relatif part du répertoire courant, même si le projet analysé
est ailleurs. Le parent doit exister ; un rapport existant est remplacé, mais les
sources analysées et la configuration du projet sont protégées contre l’écrasement.

Le rapport regroupe les classes probablement inutilisées, les usages introuvables et
les usages dynamiques à vérifier, avec leur emplacement, leur raison et leur confiance.
Les avertissements des différentes étapes restent dans le rapport avec leur contexte.
Les erreurs fatales sont écrites sur stderr et ne produisent pas de rapport.

| Code | Situation |
| --- | --- |
| `0` | Scan terminé, y compris avec des usages dynamiques ou des avertissements récupérables. |
| `1` | Au moins une classe manquante de confiance élevée, uniquement avec `--fail-on-missing`. Le rapport est quand même produit. |
| `2` | Commande/option invalide, racine absente, erreur de configuration, de lecture ou d’écriture du rapport. |

## Installation et vérifications du socle

Prérequis : **Node.js 24.x** (`.nvmrc`) et **pnpm 11.25.0**, version figée dans
`packageManager`. Si nécessaire : `npm install --global pnpm@11.25.0`.

Depuis un clone propre :

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm test
node dist/cli/index.js --help
node dist/cli/index.js scan --help
```

Les cinq composants du moteur sont implémentés, testables indépendamment et reliés à `scan`.
Sans argument, `--help` et `-h` affichent l’aide
avec un code de sortie 0. `scan --help` décrit les options, les codes de sortie
et des exemples copiables. Les tests lancent l’exécutable construit sur des projets
temporaires, y compris dans des chemins avec espaces, et vérifient les sorties,
les codes CI, les avertissements et la préservation des sources.

`pnpm-lock.yaml` fixe les dépendances, dont TypeScript. Le build nettoie uniquement
`dist/`, produit du JavaScript ESM et les déclarations TypeScript, et rend le
lanceur exécutable sur Unix. Il n’émet ni chemin absolu ni horodatage.
Les tests utilisent le lanceur natif de Node et sont compilés dans `.test-dist/`.
`pnpm test` reconstruit le paquet avant de tester son exécutable.
`pnpm typecheck` vérifie aussi les tests et l’exemple de contrat.

`pnpm pack` crée `css-cleaner-0.1.0.tgz`, avec un build préalable. Dans un projet
consommateur, installer cette archive avec `pnpm add /chemin/css-cleaner-0.1.0.tgz`,
puis lancer `pnpm exec css-cleaner --help`. Le champ `bin` du paquet expose le
véritable nom de commande `css-cleaner`.

## Points d’entrée des composants

L’API publique [`scanProject`](docs/scan-project.md) assemble le moteur sans sortie
console ni écriture de rapport. Elle accepte un répertoire ou un instantané complet
en mémoire pour les intégrations IDE ; la CLI appelle la même fonction.

```ts
import { scanProject } from "css-cleaner";

const { report } = await scanProject({ rootDir: "." });
// Exploiter report.diagnostics, report.warnings et report.completeness.
```

Les erreurs fatales rejettent la promesse avec `ScanProjectError` (code, étape,
localisation éventuelle et cause). Une analyse partielle reste un rapport v1.
L’[exemple consommateur](examples/scan-project.mjs) utilise les exports du paquet.

Les données partagées se trouvent dans [`src/contracts.ts`](src/contracts.ts),
réexportées par [`src/index.ts`](src/index.ts) avec les conventions. Les signatures
ci-dessous sont des **types de fonctions**. Les implémentations sont disponibles
dans les modules correspondants et réexportées depuis la racine du paquet.

| Module | Fonction et signature | Responsabilité |
| --- | --- | --- |
| `src/scan/index.ts` | `scanProject: ScanProject` — `ScanProjectOptions → Promise<ScanProjectResult>` | Assembler la découverte ou l’instantané, les analyses et le rapprochement ; retourner rapport et entrées analysées. |
| `src/discovery/index.ts` | `discoverProject: DiscoverProject` — `DiscoveryOptions → Promise<DiscoveredProject>` ; `createStyleImportResolver: CreateStyleImportResolver` — `DiscoveredProject → ResolveStyleImport` | Charger la configuration, découvrir/lire les sources et fournir le résolveur d’imports. |
| `src/styles/index.ts` | `analyzeStyles: AnalyzeStyles` — `readonly StyleSource[] → Promise<StyleAnalysis>` | Extraire les définitions CSS/SCSS/Sass, localisations et avertissements. |
| `src/jsx/index.ts` | `analyzeJsx: AnalyzeJsx` — `JsxAnalysisInput → Promise<JsxAnalysis>` | Extraire les usages React JS/JSX/TS/TSX en appelant le résolveur injecté. |
| `src/matching/index.ts` | `matchClasses: MatchClasses` — `AnalysisInput → AnalysisReport` | Rapprocher les identités et produire les diagnostics, sans accès disque. |
| `src/reports/index.ts` | `renderReport: RenderReport` — `(AnalysisReport, ReportFormat) → string` ; `getExitCode: GetExitCode` — `(ScanOutcome, ExitCodeOptions) → ExitCode` | Rendre en terminal, JSON ou Markdown et décider le code CI, sans écrire la sortie. |
| `src/cli/run.ts` | `runCli(args, output) → Promise<ExitCode>` | Appeler `scanProject` et gérer arguments, sorties et codes de sortie. |

Flux : découverte → analyses styles/JSX indépendantes → rapprochement →
rendu → sortie CLI. Aucune étape ne doit exécuter l’application ni imposer Next.js.
Les adaptations aux frameworks appartiennent à la découverte/résolution.

Les [conventions du contrat v1](docs/contracts.md) définissent les chemins,
positions, identités, incertitudes et ordres de tri.
[`examples/contract.ts`](examples/contract.ts) fournit `exampleProject`,
`exampleInput` et `exampleReport`, validés avec `satisfies`. L’exemple distingue
deux classes `button` dans des modules SCSS et Sass et couvre les imports
inconnus, les usages dynamiques et les candidats de diagnostic.
[`tests/contracts.test.ts`](tests/contracts.test.ts) vérifie ces identités et
l’utilisation indépendante des interfaces, sans simuler un véritable analyseur.

Créé par Antoine LE LOUËT ([https://antoine.lelouet.fr](https://antoine.lelouet.fr)).
