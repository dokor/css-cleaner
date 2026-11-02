# Analyse des styles

`src/styles/index.ts` expose `analyzeStyles: AnalyzeStyles`. L’entrée est une
liste de `StyleSource` en mémoire ; `syntax` et `scope` sont fournis par la
découverte. L’analyse ne lit pas les fichiers du projet, ne résout aucun import
et ne démarre ni compilateur Sass, ni Next.js, ni Vite. Le contrat v1 reste
inchangé. Le réexport d’implémentation dans `src/index.ts` appartient à #7.

## Extraction et positions

- PostCSS analyse le CSS ; le parseur officiel `sass-parser` analyse le SCSS et
  le Sass indenté. `postcss-selector-parser` extrait les classes des sélecteurs.
- Les classes composées, listes, pseudo-classes, descendants et imbrications
  statiques sont parcourus. Les suffixes Sass `&__title` et `&--active` sont
  développés pour chaque parent statique, y compris les listes imbriquées.
- Les noms CSS échappés sont décodés. Les commentaires, valeurs de déclaration,
  chaînes et paramètres d’at-rules ne créent pas de définitions.
- Les positions sont celles du texte original : lignes et colonnes UTF-16 à
  partir de 1, y compris les listes multilignes et CRLF. Un suffixe BEM est
  localisé sur son `&`. Le champ `selector` contient un sélecteur développé ;
  son espacement peut être normalisé par les parseurs.
- Une occurrence écrite de classe produit une définition par identité. Les
  variantes de parents ne dupliquent pas la même occurrence ; deux occurrences
  distinctes restent distinctes. Les classes héritées sans suffixe ne sont pas
  réémises à chaque règle enfant.

Les classes de module portent l’identité du fichier source. `:global(...)`,
`:local(...)`, les changements de portée sans parenthèses et les blocs de
portée explicites sont respectés. Un fichier de module peut donc avoir une
couverture locale et globale. Un fichier vide a aussi une couverture explicite.

## Incertitudes et limites

| Code stable | Comportement |
| --- | --- |
| `style-syntax-error` | Le fichier est `unreadable`, sans définition conservée ; les autres fichiers continuent. |
| `dynamic-style-selector` | Une interpolation de sélecteur rend la règle et ses descendants incertains ; ils ne produisent aucune définition certaine. |
| `unsupported-style-selector` | Un sélecteur invalide, un parent non résolu ou une expansion excessive est écarté avec une couverture `partial`. |
| `unsupported-sass-construction` | Les mixins, appels, fonctions, conditions, boucles, imports Sass, extensions, placeholders, `@at-root`, `@content` et interpolations d’at-rules ne sont pas évalués. Les sous-arbres concernés sont écartés. |

Les règles statiques indépendantes restent exploitables. `affectedScopes`
conserve l’incertitude du fichier, des parents et des descendants écartés ;
les constructions Sass pouvant générer des portées inconnues affectent les
portées globale et locale du fichier. Une erreur de parsing d’un module affecte
les deux portées, puisqu’une éventuelle échappée globale n’est plus vérifiable.
Les modules distincts entièrement analysés restent complets.

L’expansion est plafonnée à 256 alternatives par règle. L’analyse n’évalue
aucune expression Sass et ne cherche pas les définitions importées ou générées.
Elle inventorie les tokens de classe des sélecteurs, sans vérifier si les
conditions CSS, telles que `@media`, s’appliqueront dans le navigateur.

Les versions des parseurs sont verrouillées. `sass-parser` 0.5.3 publie ses
déclarations dans un autre dossier que celui annoncé par son champ `exports` ;
un adaptateur interne limite son usage à la surface PostCSS et aux spans des
sélecteurs. Les erreurs Dart sont converties en avertissements localisés.
Le watcher natif optionnel de Sass n’est pas utilisé et son script de build est
désactivé dans `pnpm-workspace.yaml`.

## Vérification

`pnpm typecheck` et `pnpm test` vérifient le socle et les cas propres aux styles.
Après compilation des tests, `node --test .test-dist/tests/styles.test.js`
exécute seulement les tests de ce composant. Ces tests utilisent exclusivement
des textes en mémoire, indépendamment des étapes de découverte et JSX.
