# CSS Cleaner

CSS Cleaner est un projet de CLI qui aide à nettoyer progressivement les styles d’une application React, avec ou sans Next.js. Son objectif est de repérer les classes probablement inutilisées et les références à des styles manquants, puis d’indiquer où vérifier chaque résultat avant de modifier le code.

**État du projet** — Le socle TypeScript est disponible. Le moteur d’audit est en développement. Les fonctionnalités décrites ci-dessous constituent le périmètre du MVP. [Suivre l’avancement sur GitHub](https://github.com/dokor/css-cleaner/issues/9).

## Ce que l’outil analysera

- **Styles** — CSS, SCSS et Sass indenté, en fichiers globaux ou en CSS Modules (`.module.css`, `.module.scss`, `.module.sass`). L’analyse couvrira les sélecteurs composés et les variantes BEM imbriquées.
- **Composants React** — Classes écrites dans `className`, accès comme `styles.title`, conditions, appels à `clsx` ou `classnames` et chaînes de caractères interpolées.
- **Portée des noms** — Une référence à `styles.title` sera recherchée dans le module importé par le composant. Une classe homonyme dans un autre module ne pourra pas masquer une faute.

## Exemple de diagnostic

Si un composant construit une classe avec `button--${variant}`, l’analyse pourra rapprocher ce motif de `.button--primary` et `.button--secondary`. Le rapport les présentera comme des candidates à vérifier. À l’inverse, si le composant lit `styles.primray` et que son module déclare seulement `.primary`, le rapport signalera l’accès manquant et sa ligne dans le composant.

## Utilisation prévue

La commande prévue est `css-cleaner scan .`, depuis la racine du projet. Elle analysera les sources en lecture seule, sans démarrer de serveur ni compiler l’application. Le MVP sera validé sur deux projets témoins, l’un sous Next.js et l’autre sous React avec Vite.

Le rapport regroupera les classes probablement inutilisées, les usages introuvables et les usages dynamiques à vérifier. Chaque diagnostic précisera son emplacement, sa raison et son niveau de confiance. Les formats prévus sont le terminal, JSON et Markdown. En CI, l’option `--fail-on-missing` permettra de faire échouer le contrôle sur les classes manquantes à confiance élevée.

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

Le socle fournit actuellement les contrats, les conventions et l’aide de la CLI.
Les parseurs, le rapprochement, les rendus et le branchement de `scan` restent
réservés aux tickets suivants. Sans argument, `--help` et `-h` affichent l’aide
avec un code de sortie 0. `scan --help` décrit la commande réservée.
`scan [chemin]` ne réalise aucun audit et sort avec le code 2, comme les
commandes/options inconnues.

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

## Points d’entrée pour les tickets suivants

Les données partagées se trouvent dans [`src/contracts.ts`](src/contracts.ts),
réexportées par [`src/index.ts`](src/index.ts) avec les conventions. Les signatures
ci-dessous sont des **types de fonctions** ; chaque ticket peut ajouter sa
fonction dans le module réservé et la tester avec des entrées en mémoire.

| Module réservé | Fonction à fournir et signature | Responsabilité |
| --- | --- | --- |
| `src/discovery/index.ts` | `discoverProject: DiscoverProject` — `DiscoveryOptions → Promise<DiscoveredProject>` ; `createStyleImportResolver: CreateStyleImportResolver` — `DiscoveredProject → ResolveStyleImport` | Charger la configuration, découvrir/lire les sources et fournir le résolveur d’imports. |
| `src/styles/index.ts` | `analyzeStyles: AnalyzeStyles` — `readonly StyleSource[] → Promise<StyleAnalysis>` | Extraire les définitions CSS/SCSS/Sass, localisations et avertissements. |
| `src/jsx/index.ts` | `analyzeJsx: AnalyzeJsx` — `JsxAnalysisInput → Promise<JsxAnalysis>` | Extraire les usages React JS/JSX/TS/TSX en appelant le résolveur injecté. |
| `src/matching/index.ts` | `matchClasses: MatchClasses` — `AnalysisInput → AnalysisReport` | Rapprocher les identités et produire les diagnostics, sans accès disque. |
| `src/reports/index.ts` | `renderReport: RenderReport` — `(AnalysisReport, ReportFormat) → string` ; `getExitCode: GetExitCode` — `(ScanOutcome, ExitCodeOptions) → ExitCode` | Rendre en terminal, JSON ou Markdown et décider le code CI, sans écrire la sortie. |
| `src/cli/run.ts` | `runCli(args, output) → number` | Assembler les étapes et gérer arguments, sorties et codes de sortie ; l’aide seule est implémentée. |

Flux prévu : découverte → analyses styles/JSX indépendantes → rapprochement →
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
