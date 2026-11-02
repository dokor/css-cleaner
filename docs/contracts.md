# Contrat d’analyse v1

Le contrat partagé est `src/contracts.ts`. Les résultats sont sérialisables en
JSON ; les tableaux sont `readonly` pour permettre des tests sans mutation.
`AnalysisReport.schemaVersion` vaut `1`.

## Entrées et sorties

La découverte retourne `DiscoveredProject` : configuration, textes des styles,
textes React et avertissements. L’analyse des styles reçoit les `StyleSource`
et retourne `StyleAnalysis`. La découverte fournit aussi une fabrique
`CreateStyleImportResolver` liée au projet/configuration/catalogue de styles.
L’analyse JSX reçoit `JsxAnalysisInput`, dont `resolveStyleImport` est ce service
injecté, et retourne `JsxAnalysis`. Les tests JSX peuvent fournir leur propre
résolveur. Son entrée `StyleImportRequest` contient le spécificateur, le binding
éventuel et la localisation de l’import (`location.file` est le fichier importeur).

`AnalysisInput` réunit ces deux résultats, les classes globales externes autorisées
par la configuration et les avertissements de découverte.
Les avertissements des analyseurs restent dans `styles.warnings` et
`jsx.warnings`. Le rapprochement conserve les trois ensembles dans le rapport.
Le rendu reçoit uniquement ce rapport et un format (`terminal`, `json`, `markdown`).
Les interfaces sont indépendantes du système de fichiers, sauf la découverte
et la résolution d’imports qui pourront lire la configuration du projet.

`ProjectConfig.aliases` contient les mappings de chemins relatifs à la racine.
`externalGlobals` contient des noms exacts ou des motifs structurés. Ce contrat
est normalisé ; le ticket de configuration définit le format déclaratif du fichier
local et le traduit vers ces valeurs, avec des collections vides par défaut.

## Chemins et positions

- `ProjectPath` est relatif à la racine et utilise `/`, en conservant la casse.
  `projectPath()` convertit les séparateurs Windows et rejette les chemins
  absolus, vides, les préfixes de lecteur et les segments vides, `.` ou `..`.
  Les producteurs doivent construire ces chemins à partir de la racine choisie.
- Seul `ProjectConfig.rootDir` est un chemin absolu de l’hôte ; il n’apparaît
  pas dans `AnalysisReport`. Les globs de configuration sont relatifs à la racine.
  Les spécificateurs d’import restent leur texte original, avant résolution.
- Lignes et colonnes commencent à **1**. La colonne est facultative et mesurée
  en unités UTF-16. `sourceLocation()` valide les bornes ; les producteurs sont
  responsables des positions exactes dans les sources originales.

## Styles et identités

`StyleSyntax` couvre `css`, `scss` et `sass` (syntaxe indentée), chacune pouvant
être globale ou en module. `StyleFile.scope` est la portée par défaut ; chaque
`ClassSymbol` garde sa propre portée explicite, notamment pour `:global` dans
un module ou les constructions `:local`.

Les noms sont décodés, sans le point du sélecteur. Une identité globale est
`scope + name` ; une identité de module est `scope + file + name`.
`classSymbolKey()` produit une clé sans ambiguïté de séparateurs. Deux fichiers
`.module.*` contenant `.button` représentent deux identités. Plusieurs
déclarations d’une même identité restent des définitions distinctes.
La localisation de la définition indique sa déclaration ; le `file` du symbole
indique le module propriétaire.

## Imports et usages React

Une référence d’import `resolved` contient sa cible relative et sa portée.
Une référence `unknown` garde sa raison et des chemins candidats éventuels ;
elle ne doit pas être assimilée à une résolution réussie. `binding` est absent
pour un import à effet de bord.

Un usage `static` contient un nom connu ; un usage `dynamic` conserve
l’expression, la raison de l’incertitude et des noms candidats éventuels.
Une liste vide de candidats n’établit aucune absence d’usage. Un accès
`styles[key]`, une prop ou une construction conditionnelle peut être représenté
sans inventer de nom. Les producteurs peuvent émettre les tokens connus d’une
expression comme usages statiques, et sa partie incertaine comme usage dynamique.
Chaque usage indique une référence globale ou un import de module, y compris
si cet import est encore inconnu. Aucun framework React n’est imposé.

`ClassNamePattern.parts` est une séquence non vide de fragments `literal` et
`unknown`, à concaténer. Un fragment inconnu accepte zéro ou plusieurs caractères
dans un nom de classe. Par exemple `button--${variant}` devient
`[{ kind: "literal", value: "button--" }, { kind: "unknown" }]`.
`styles[key]` devient un unique fragment inconnu limité à son module.
Le rapprochement peut exploiter ces parties connues sans réanalyser JavaScript.
Le même modèle représente les motifs des classes globales externes autorisées.

## Diagnostics et avertissements

`category`, `confidence` (`high`, `medium`, `low`), `reason` et `location` sont
obligatoires. `symbol` est facultatif. `candidates` est toujours une liste,
éventuellement vide, de symboles localisés avec leur propre confiance et raison.
Une suggestion n’est pas une preuve ni une correction. Les politiques de
rapprochement et de confiance seront implémentées dans les tickets suivants.

`AnalysisWarning` conserve l’étape, un code stable, une raison et une position.
Les limites de parsing doivent rester visibles ; un avertissement peut aussi
devenir un diagnostic `analysis-warning` sans disparaître de `report.warnings`.

`affectedScopes` limite l’incertitude d’un avertissement à la portée globale,
à un module précis ou au projet entier si la portée est inconnue. Une liste vide
indique un avertissement informatif. `StyleAnalysis.coverage` contient, par fichier
et portée, l’état `complete`, `partial` ou `unreadable`, y compris pour un fichier
sans classe. Un module peut aussi avoir une entrée globale pour `:global`.
Une entrée absente signifie une analyse inconnue, jamais une analyse complète.
Ces données permettent au rapprochement de rester prudent dans la portée affectée
sans dégrader les diagnostics d’un module distinct entièrement analysé.

`AnalysisReport.completeness` indique explicitement un scan `complete` ou
`partial`. `ScanOutcome` distingue ce succès (même partiel) d’une erreur fatale.
La future fonction `GetExitCode` décidera : 0 pour le succès, 1 uniquement en mode
`failOnMissing` avec une classe certainement manquante, 2 pour une erreur fatale.
Les avertissements récupérables restent dans le rapport.

## Tri stable

Les producteurs parcourent les fichiers par chemin normalisé avec `compareText`
(comparaison UTF-16, sans `localeCompare`). Les définitions, usages et imports
s’ordonnent par `compareLocations` : fichier, ligne numérique, colonne numérique
(colonne absente avant les colonnes connues). À position égale : clé de symbole
pour les définitions, nom/expression pour les usages, spécificateur pour les imports.

Les diagnostics utilisent `compareDiagnostics` : position, catégorie, clé de
symbole, confiance puis raison, avec comparaison textuelle des derniers champs.
Les candidats s’ordonnent par position puis clé de symbole, confiance et raison ;
les avertissements par position puis étape, code et raison. La couverture s’ordonne
par chemin puis portée ; les motifs conservent l’ordre de leurs fragments. Les égalités complètes
conservent l’ordre d’émission de la source. Les rendus conservent ces ordres.

## Exemple de référence

`examples/contract.ts` fournit un projet, une entrée d’analyse et un rapport
écrits à la main et validés avec `satisfies`. Le chemin `/example/project` est
illustratif : ces fixtures n’accèdent pas au disque. Elles couvrent CSS global,
modules SCSS/Sass, deux classes homonymes, imports résolus/inconnus, usages
statiques/dynamiques et diagnostics avec candidats. Les types autorisent les
six combinaisons syntaxe/portée.

Les adaptateurs de `tests/contracts.test.ts` retournent uniquement ces fixtures.
Ils valident la composition des signatures, sans prétendre parser ni rapprocher
des sources. Le test des homonymes vérifie la clé, le rattachement de l’usage et
le candidat du module Header, sans fusion avec le module Footer.
