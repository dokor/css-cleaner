# API de scan de projet

`scanProject` est le point d’entrée commun du moteur, appelé par la CLI et
réutilisable par une intégration IDE. Il est exporté depuis la racine du paquet,
avec `ScanProject`, `ScanProjectOptions`, `ScanProjectResult`, `ScanProjectError`,
`ScanProjectErrorCode` et `ScanProjectStage`.

## Analyser un répertoire

```ts
import { scanProject, ScanProjectError } from "css-cleaner";
import type { ScanProjectResult } from "css-cleaner";

try {
  const result: ScanProjectResult = await scanProject({ rootDir: "." });
  const { report, project } = result;
  // report : AnalysisReport v1 ; project : les entrées effectivement analysées.
  // L'appelant choisit comment afficher ou conserver ces données.
  void report;
  void project;
} catch (error) {
  if (!(error instanceof ScanProjectError)) throw error;
  // Exploiter error.code, error.stage et error.location sans parser error.message.
}
```

`rootDir` est obligatoire pour une analyse disque. Les options `include` et
`exclude` ont exactement la sémantique de `discoverProject` : `include` remplace
la sélection configurée et `exclude` complète les exclusions. La configuration
déclarative `css-cleaner.config.json` est chargée sans exécuter l’application,
Next.js, Vite ou une configuration JavaScript.

Le résultat contient :

- `report` : diagnostics, avertissements et complétude selon le contrat v1.
- `project` : configuration normalisée, textes React/styles et avertissements de
  découverte utilisés pour ce scan. La CLI garde ce catalogue pour empêcher
  `--output` d’écraser une source ou la configuration, y compris via un lien.

Le résultat complet n’est pas un nouveau format de rapport. Sérialiser `report`
pour échanger un rapport v1 : `project` contient les textes des sources et un
`config.rootDir` absolu propre à la machine. Le rapport garde ses chemins relatifs,
ses positions 1-based en UTF-16 et son tri déterministe. Son `schemaVersion`
reste `1` ; les contrats existants ne changent pas.

## Analyser un instantané en mémoire

L’entrée `snapshot` réutilise `DiscoveredProject`, le catalogue normalisé existant.
Elle contient **toutes** les sources du périmètre à analyser, pas seulement le
document actif. Une intégration peut partir du `project` d’un scan disque et y
remplacer le contenu d’un fichier ouvert, ou construire le catalogue entièrement
en mémoire.

```ts
import { projectPath, scanProject } from "css-cleaner";
import type { DiscoveredProject } from "css-cleaner";

const snapshot: DiscoveredProject = {
  config: {
    rootDir: "/workspace/example", // Métadonnée : ce répertoire n'est pas lu.
    include: ["**/*"], exclude: [], aliases: {}, externalGlobals: [],
  },
  styles: [{
    file: projectPath("src/Card.module.css"), syntax: "css", scope: "module",
    content: ".title {}",
  }],
  react: [{
    file: projectPath("src/Card.tsx"), syntax: "tsx",
    content: "import s from './Card.module.css'; export default () => <div className={s.typo} />;",
  }],
  warnings: [],
};

const { report } = await scanProject({ snapshot });
// report signale la référence manquante « typo » dans ce module.
void report;
```

Ce mode ne découvre ni ne lit aucun fichier du projet et ne recharge pas sa
configuration. Les imports de styles sont résolus exclusivement dans le catalogue
en mémoire, avec ses alias. Les globs de `snapshot.config` décrivent le catalogue ;
ils ne refiltrent pas ses sources. Les chemins, syntaxes, portées et avertissements
doivent déjà respecter le contrat `DiscoveredProject`. Un import absent reste
non résolu, sans lecture de secours sur disque.

`snapshot` ne se combine pas avec `rootDir`, `include` ou `exclude`. L’instantané
est copié avant la première suspension asynchrone, sans modifier les entrées de
l’appelant. Des modifications ultérieures du catalogue de l’éditeur n’altèrent
pas un scan déjà lancé. Chaque appel possède son propre catalogue et résolveur.
Le suivi des versions de documents, l’annulation et les événements de fichiers
restent à la charge des futures intégrations watch/LSP.

## Erreurs et analyses partielles

Une erreur fatale rejette la promesse avec `ScanProjectError` :

| Champ | Signification |
| --- | --- |
| `code` | Code de découverte existant (`invalid-root`, `invalid-config`, `unreadable-config`, `unreadable-directory`, `unreadable-source`), `invalid-options` ou `scan-failed`. |
| `stage` | `discovery`, `styles`, `jsx` ou `matching`. La préparation d’un instantané utilise `discovery`. |
| `location` | Position relative à la racine lorsqu’elle est disponible ; absente par exemple pour une racine inexistante. |
| `cause` | Erreur d’origine, conservée pour investigation. |
| `message` | Explication lisible, qui ne constitue pas un protocole machine. |

`invalid-options` couvre les entrées de premier niveau invalides et les mélanges
disque/instantané. `scan-failed` identifie une exception inattendue d’une étape ;
ce n’est pas un diagnostic de parsing récupérable. Les fonctions publiques de
découverte conservent leur propre type `DiscoveryError` ; `scanProject` le traduit
en `ScanProjectError` en conservant son code, sa localisation et sa cause.

Les erreurs de syntaxe récupérables, imports inconnus et autres limites d’analyse
restent dans `report.warnings` et les diagnostics. Un rapport `partial` est donc
un résultat de scan, même si aucun diagnostic n’est bloquant.

L’API n’écrit ni sur stdout/stderr ni dans les sources et ne produit aucun fichier.
Le rendu, la sortie fichier et la politique de code CI restent séparés : l’appelant
peut utiliser `renderReport(report, format)` et
`getExitCode({ status: "success", report }, options)`.

L’exemple consommateur [`examples/scan-project.mjs`](../examples/scan-project.mjs)
utilise uniquement les exports publics. Après le build, le lancer avec
`node examples/scan-project.mjs /chemin/du/projet`. Il affiche explicitement le
rapport ou les champs d’une erreur fatale ; ces sorties appartiennent à l’exemple.
