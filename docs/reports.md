# Rendus et codes de sortie

`src/reports/index.ts` fournit les fonctions pures `renderReport` et `getExitCode`
selon les signatures du contrat v1. Elles reçoivent des données en mémoire,
sans lire les sources, écrire un fichier ou modifier le rapport. La CLI les appelle
après le rapprochement et gère l’écriture sur stdout ou dans `--output <fichier>`.
Les deux fonctions sont aussi réexportées depuis la racine du paquet.

La [politique CI configurable](ci-policy.md) fournit les fonctions pures
`resolvePolicy` et `evaluatePolicy`. `renderReport` accepte un troisième argument
optionnel `policy` : terminal/Markdown ajoutent gravités, seuils, activations et
décisions de blocage. Le JSON reste le rapport brut v1.

```ts
import { exampleReport } from "../examples/contract.js";
import { getExitCode, renderReport } from "../src/reports/index.js";

const terminal = renderReport(exampleReport, "terminal");
const markdown = renderReport(exampleReport, "markdown");
const json = renderReport(exampleReport, "json");
const exitCode = getExitCode(
  { status: "success", report: exampleReport },
  { failOnMissing: true },
);
```

Les rendus terminal et Markdown commencent par l’état du scan et les décomptes
par catégorie, puis présentent les classes probablement inutilisées, les classes
manquantes et les usages dynamiques. Ces trois sections sont présentes même si
elles sont vides. Les imports non résolus et les diagnostics d’analyse disposent
de sections supplémentaires lorsqu’ils existent. Chaque diagnostic conserve sa
catégorie, son emplacement `fichier:ligne[:colonne]`, sa confiance, sa raison et
ses candidats avec leurs propres emplacements, identités, confiances et raisons.
Les identités de module indiquent le fichier propriétaire, même lorsque la
déclaration provient d’un autre fichier.

Les avertissements apparaissent séparément avec leur étape, code, raison,
emplacement et portées affectées. Un avertissement également présent dans les
diagnostics reste dans les deux collections : les décomptes distinguent ces deux
ensembles. Un rapport `partial` affiche « Scan incomplet (partial). », y compris
si ses listes sont vides. Les avertissements informatifs ne rendent pas à eux
seuls un scan incomplet : le rendu respecte `report.completeness`.

Le JSON restitue directement `AnalysisReport` v1, sans enveloppe ni changement du
contrat. Les consommateurs calculent les comptes depuis `diagnostics` et
`warnings`. Les clés des objets sont triées selon `compareText`, y compris dans
les structures imbriquées, pour rendre identiques deux objets dont seul l’ordre
d’insertion des propriétés diffère. Les tableaux gardent l’ordre fourni par les
producteurs ; les rendus lisibles conservent cet ordre dans chaque catégorie.
Les trois formats utilisent des fins de ligne LF et un saut de ligne final,
sans horodatage, couleur ou donnée d’environnement. Le Markdown protège la
ponctuation des sources ; les rendus lisibles échappent les retours de ligne et
caractères de contrôle contenus dans les données. Le JSON préserve leur valeur.

| Situation | Code |
| --- | --- |
| `ScanOutcome.status === "error"` | `2` |
| Succès, au moins un diagnostic bloquant selon la politique | `1` |
| Succès partiel, avec `policy.requireComplete: true` | `1` |
| Succès accepté par la politique, même partiel ou accompagné d’avertissements récupérables par défaut | `0` |

La politique considère la confiance du diagnostic, pas celle de ses candidats.
Un diagnostic bloque si sa règle est activée, sa gravité vaut `error` et sa
confiance atteint le seuil configuré. Par défaut toutes les gravités sont
`warning` ou `info`, donc aucun diagnostic ne bloque. Le raccourci historique
`failOnMissing` impose toujours `error` et `high` à `undefined-class` ; sans
nouvelle configuration, lui seul peut produire le code `1`.

Un scan partiel peut contenir une classe manquante à confiance élevée dans une
portée entièrement analysée ; il conserve alors le code `1` si le raccourci est
actif. Le rapprochement reste responsable de cette confiance ; la politique ne
la modifie pas. Les avertissements déjà présents dans les diagnostics ne sont
pas comptés une deuxième fois dans `blockingCount`.

Après `pnpm install --frozen-lockfile` :

```sh
pnpm typecheck
pnpm test
node --test .test-dist/tests/reports.test.js
```

Les tests utilisent le rapport d’exemple du socle et des fixtures en mémoire.
Ils vérifient les trois formats, les localisations et candidats, les avertissements,
les rapports vides et partiels, la stabilité, l’absence de mutation, ainsi que
les codes `0`, `1` et `2`.
