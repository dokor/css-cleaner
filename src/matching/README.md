# Rapprochement

`matchClasses: MatchClasses` est une fonction synchrone de `AnalysisInput` vers
`AnalysisReport`. Elle n’accède pas au disque et ne modifie pas ses entrées.
Le contrat v1 reste inchangé ; l’implémentation est aussi réexportée à la racine du
paquet et appelée par la commande `scan`.

Une identité de module inclut son fichier propriétaire et son nom, indépendamment
de son extension CSS, SCSS ou Sass. Une chaîne globale consulte exclusivement
les identités globales, y compris celles déclarées avec `:global` dans un module.
Un usage statique trouvé protège toutes les déclarations de cette identité.

Les motifs concatènent leurs fragments littéraux et inconnus. Chaque fragment
inconnu accepte zéro ou plusieurs caractères ; les fragments littéraux ne sont
jamais interprétés comme des expressions régulières. Les candidats sont les
définitions compatibles de la portée visée, avec toutes leurs positions.
Les noms proposés par JSX restent des possibilités : le contrat ne garantit
pas une liste exhaustive, donc ils ne restreignent pas le motif. Aucun symbole
ni emplacement n’est inventé pour un nom sans définition.

La confiance d’une conclusion prend le niveau le plus prudent applicable :

| Niveau | Conditions |
| --- | --- |
| `high` | Portée intégralement couverte, sans avertissement affectant cette portée ni usage dynamique compatible pour une classe inutilisée. |
| `medium` | Couverture partielle, ou usage dynamique avec au moins un fragment littéral non vide. |
| `low` | Couverture absente/illisible, avertissement affectant la portée, import inconnu, ou clé dynamique sans fragment connu. |

Un usage dynamique produit toujours `dynamic-usage`, même sans candidat, et ne
produit jamais d’alerte de classe manquante. Les candidats sans usage statique
peuvent aussi apparaître comme `unused-class`, au plus à `medium` ou à `low`
selon le motif ; leur raison mentionne l’usage dynamique compatible. Une clé
libre protège ainsi tous les exports de son module contre une conclusion élevée.
Une clé statique absente reste vérifiable même si un autre usage est dynamique.

La couverture d’un module ne concerne que ce module. La couverture globale
agrège les entrées globales ainsi que les fichiers des définitions globales et
les imports résolus globaux : une couverture manquante reste inconnue, y compris
pour un fichier sans définition. Un accès local à un import déclaré global reste
prudent si aucun export local n’est établi.

Un import inconnu produit `unresolved-import` à l’import et une éventuelle
`undefined-class` à confiance faible à chaque accès statique invérifiable.
Ses fichiers candidats ne sont jamais assimilés à une résolution réussie.
L’incertitude affecte les modules candidats et la portée globale, puisque cet
import pourrait apporter des styles globaux. Sans candidat, aucun module précis
n’est désigné : les modules indépendants entièrement analysés gardent leurs
diagnostics habituels. Un avertissement de portée `project` peut explicitement
étendre cette incertitude à tous les modules.

Les noms et motifs externes autorisent les usages globaux correspondants sans
alerte de classe manquante. Ils ne prouvent pas l’usage d’une déclaration locale
et ne satisfont jamais un accès à un CSS Module.

Tous les avertissements des trois étapes sont conservés et produisent également
`analysis-warning`. Une portée affectée non vide, une couverture incomplète ou
un import inconnu rendent le rapport `partial`. Un usage dynamique ou un simple
avertissement informatif ne rend pas à lui seul l’extraction partielle.

Les diagnostics identiques à une même position sont fusionnés avec leurs
candidats. Les positions distinctes restent distinctes. Diagnostics, candidats
et avertissements suivent les comparaisons UTF-16 du socle ; les portées des
avertissements départagent les égalités des autres champs de tri. Les égalités
complètes conservent l’ordre source. Les avertissements d’origine ne sont pas
supprimés, même quand leur diagnostic est dédupliqué.

Les tests utilisent uniquement des données en mémoire. La confiance dépend de
la couverture et des avertissements fournis par les étapes précédentes. Ce
module ne détermine pas les valeurs à l’exécution et ne propose pas de correction
orthographique des noms statiques absents.
