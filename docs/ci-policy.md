# Politique CI : gravité, confiance et blocage

Le moteur produit un `AnalysisReport` v1 avec la confiance de chaque détection.
La politique s’applique ensuite, sans modifier les diagnostics, leurs candidats,
leurs preuves ou la complétude. Une gravité `error` ne rend pas une détection
plus certaine.

## Configuration du projet

Dans `css-cleaner.config.json`, ajouter un champ optionnel `policy` :

```json
{
  "policy": {
    "requireComplete": false,
    "rules": {
      "undefined-class": { "severity": "error", "minConfidence": "high" },
      "unused-class": { "severity": "error", "minConfidence": "high" },
      "dynamic-usage": { "severity": "info" },
      "unresolved-import": { "enabled": false }
    }
  }
}
```

Chaque champ est optionnel. Les catégories absentes et les propriétés omises
gardent leurs valeurs par défaut :

| Catégorie | Activée | Gravité | Confiance minimale CI |
| --- | --- | --- | --- |
| `unused-class` | oui | `warning` | `high` |
| `undefined-class` | oui | `warning` | `high` |
| `dynamic-usage` | oui | `info` | `high` |
| `unresolved-import` | oui | `warning` | `high` |
| `analysis-warning` | oui | `warning` | `high` |

Sans politique ni option CI, aucun diagnostic ne fait échouer la commande.
Une catégorie désactivée reste dans le rapport et dans l’évaluation, avec
`enabled: false` et `blocking: false` ; la désactivation ne supprime pas de preuve.

## Table de décision

Un diagnostic bloque si les trois conditions sont réunies : règle activée,
gravité `error`, confiance du diagnostic au moins égale à `minConfidence`.
L’ordre est `low < medium < high`. La confiance des candidats n’intervient pas.

| Règle | Gravité | Seuil | Confiance du diagnostic | Bloque |
| --- | --- | --- | --- | --- |
| désactivée | quelconque | quelconque | quelconque | non |
| activée | `info` ou `warning` | quelconque | quelconque | non |
| activée | `error` | `high` | `low` ou `medium` | non |
| activée | `error` | `high` | `high` | oui |
| activée | `error` | `medium` | `low` | non |
| activée | `error` | `medium` | `medium` ou `high` | oui |
| activée | `error` | `low` | `low`, `medium` ou `high` | oui |

`requireComplete` vaut `false` par défaut. Avec `true`, un rapport `partial`
échoue même sans diagnostic bloquant. Désactiver `analysis-warning` ou changer
une gravité ne contourne pas cette exigence. L’état partiel et les avertissements
restent visibles.

| Situation | Code de sortie |
| --- | --- |
| Erreur fatale, argument/configuration invalide, échec de lecture/écriture | `2` |
| Au moins un diagnostic bloquant, ou complétude exigée non satisfaite | `1` |
| Sinon | `0` |

Un échec de politique conserve le rapport sur stdout ou dans `--output`.
Une erreur fatale reste distincte et peut empêcher sa production. Les erreurs
d’écriture du rapport gardent la priorité avec le code `2`.

Les avertissements déjà représentés par un diagnostic `analysis-warning` ne sont
pas ajoutés une deuxième fois au compteur de blocage. La politique évalue la
collection `diagnostics` ; `warnings` conserve les détails et les portées affectées.

## Options CLI et priorité

```sh
css-cleaner scan . --rule undefined-class=error:high --rule unused-class=error:high
css-cleaner scan . --rule dynamic-usage=info --rule unresolved-import=off
css-cleaner scan . --require-complete --format json --output rapport.json
css-cleaner scan . --allow-partial --rule unused-class=warning
css-cleaner scan . --fail-on-missing
```

`--rule categorie=error|warning|info[:high|medium|low]` modifie la gravité et
réactive la catégorie. Sans suffixe de confiance, le seuil du fichier est conservé,
ou `high` en l’absence de réglage. `--rule categorie=off` désactive la catégorie
sans modifier ses autres propriétés. Un seuil après `off` est invalide.

`--require-complete` impose une analyse complète ; `--allow-partial` accepte une
analyse partielle, même si le fichier exige le contraire.

L’ordre de priorité, champ par champ, est :

1. Valeurs par défaut.
2. `policy` du fichier du projet.
3. `--fail-on-missing`, qui impose à `undefined-class` les valeurs
   `enabled: true`, `severity: error`, `minConfidence: high`.
4. Options explicites `--rule`, `--require-complete` ou `--allow-partial`.

Ces combinaisons sont rejetées avec le code `2` avant la découverte et l’écriture :

- `--fail-on-missing` avec `--rule undefined-class=...`, même avec des réglages
  équivalents. Le raccourci peut modifier une règle provenant du fichier.
- Deux `--rule` pour la même catégorie ; utiliser une seule définition complète.
- `--require-complete` avec `--allow-partial`.

Catégories, gravités, confiances, clés inconnues et valeurs mal typées sont
refusées. Une erreur du fichier est localisée dans `css-cleaner.config.json` avec
le chemin du champ ; une option CLI ne masque pas une configuration invalide.

## API commune pour CI et IDE

```ts
import { evaluatePolicy, getExitCode, resolvePolicy, scanProject } from "css-cleaner";
import type { PolicyConfig } from "css-cleaner";

const { report, project } = await scanProject({ rootDir: "." });
const overrides: PolicyConfig = {
  rules: { "unused-class": { severity: "error", minConfidence: "high" } },
};
const policy = resolvePolicy(project.config.policy, overrides);
const evaluation = evaluatePolicy(report, policy);
const exitCode = getExitCode({ status: "success", report }, { policy });

for (const item of evaluation.diagnostics) {
  // item.diagnostic.confidence : confiance inchangée du moteur.
  // item.severity / item.enabled / item.minConfidence : règle de présentation/CI.
  // item.blocking : décision pour cette détection.
  void item;
}
void exitCode;
```

Ces fonctions sont pures et exportées depuis la racine du paquet avec leurs types.
`resolvePolicy(config?, overrides?, { failOnMissing? })` applique les priorités et
détecte les conflits. `evaluatePolicy(report, policy?)` retourne la politique
résolue, les diagnostics évalués, `blockingCount`, `incompleteFailure` et `failed`.
Les diagnostics évalués gardent une référence en lecture seule au diagnostic brut.
`PolicyError` expose `code`, `field` et `detail`, sans parsing de message.
Les fonctions d’évaluation et de résolution rejettent une politique invalide avec
cette erreur ; la CLI la traduit en code `2`.

`scanProject` conserve son rôle d’analyse et ne décide pas de bloquer la CI,
y compris quand son instantané contient une configuration `policy`.
`getExitCode` accepte toujours `{ failOnMissing: true }` et accepte désormais
`{ policy }` ; une erreur fatale reste `2`.

Terminal et Markdown affichent gravité, confiance et blocage quand une nouvelle
politique est explicitement fournie par le fichier ou la CLI. Sans nouvelle
politique, y compris avec le seul raccourci historique, les rendus existants sont
conservés. L’API accepte `renderReport(report, "terminal", policy)` ou son
équivalent Markdown.

Le format `json` reste exactement le rapport brut v1, même avec une politique.
Pour consulter ou sérialiser la gravité et la décision en code, utiliser le résultat
de `evaluatePolicy` séparément ; il ne remplace pas le schéma d’analyse.
La baseline et l’acceptation du passif restent dans l’issue #25.
