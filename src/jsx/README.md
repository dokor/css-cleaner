# Analyse des usages React

`analyzeJsx: AnalyzeJsx` reçoit les sources en mémoire et le service
`resolveStyleImport` du contrat v1. Il ne lit pas le disque, ne charge pas les
modules JavaScript et n’exécute pas l’application. Aucun changement du contrat
partagé ni réexport d’implémentation dans `src/index.ts` n’est nécessaire.

Le parseur TypeScript 5.9.3, déjà utilisé par le socle, devient une dépendance
d’exécution pour que l’analyse fonctionne après une installation de production.
Les quatre syntaxes JS/JSX/TS/TSX acceptent du JSX. Un programme TypeScript en
mémoire sert uniquement à identifier les bindings lexicaux : un paramètre local
homonyme d’un import n’hérite pas de son identité.

## Extraction

- Les attributs `className` fournissent un contexte de classe. Les chaînes de
  texte JSX, les autres attributs, les chaînes isolées et les arguments des
  fonctions arbitraires ne sont pas considérés comme des classes.
- Les appels aux imports ESM de `clsx` et `classnames` fournissent aussi ce
  contexte, même dans une variable intermédiaire. Les imports renommés, le
  `clsx` nommé et les accès aux exports des imports namespace sont reconnus.
  Les arguments tableaux sont parcourus récursivement ; pour les objets, ce
  sont les clés qui fournissent les classes, pas les valeurs conditionnelles.
- Les deux branches d’un ternaire et la branche droite de `&&` sont analysées.
  Les valeurs possibles des opérateurs `||` et `??` sont aussi conservées.
- Les imports de CSS, SCSS et Sass sont confiés au résolveur injecté, y compris
  les imports à effet de bord. Le résultat du résolveur détermine la portée.
  Les accès par propriété ou clé littérale gardent leur import ; une clé inconnue
  produit un motif dynamique limité à cet import. Les imports non résolus sont
  conservés intégralement, avec leur raison et leurs candidats.
- Les mots fixes d’une chaîne modèle deviennent des usages statiques. Les mots
  interpolés deviennent des motifs séparés conservant préfixes et suffixes.
  Une interpolation isolée comme `${styles.title}` garde son identité de module.
  Les usages dynamiques gardent l’expression source et une raison, sans inventer
  de candidats.
- Les lectures de module comme `const name = styles.title` ou `styles[key]`
  sont conservées aussi hors des attributs JSX et des helpers. Une lecture
  statique protège la classe référencée ; une clé calculée protège les candidats
  compatibles de son module. Un objet de module affecté à une variable ou
  déstructuré dans une déclaration rend ses exports incertains, même si ses
  usages ultérieurs ne sont pas traçables. Les bindings homonymes restent distincts.

Les positions sont en lignes et colonnes UTF-16 à partir de 1. Un token littéral
pointe sur son premier caractère dans la source, y compris en présence d’un
échappement JavaScript. Une lecture de module pointe au début de l’accès ; une
expression inconnue au début de l’expression. Les résultats et les appels au
résolveur suivent l’ordre stable du contrat. Les entrées ne sont pas modifiées.

## Limites explicites

L’analyse est syntaxique et conservative : elle ne prouve pas la valeur des
conditions et conserve donc les deux branches littérales. Elle n’effectue pas de
propagation de valeurs ou d’alias locaux, d’analyse inter-fichiers ni de résolution
des helpers CommonJS, réexportés ou liés avec `classnames/bind`. Une variable
utilisée dans `className`, un appel inconnu ou une concaténation non prise en
charge reste un usage dynamique. Les lectures connues de CSS Modules sont
comptées comme usages potentiels, sans prouver leur application au DOM.
Les spreads d’attributs JSX ne sont pas développés.

Les erreurs syntaxiques produisent des avertissements `jsx-parse-error` avec
leur position et une portée projet, tout en conservant les usages que le parseur
peut récupérer. Une expression dynamique valide utilise les champs d’incertitude
de `ClassUsage`, sans être assimilée à une erreur de parsing.

Les tests de `tests/jsx.test.ts` utilisent uniquement des textes et des résolveurs
en mémoire. Après `pnpm test`, ils peuvent être relancés seuls avec
`node --test .test-dist/tests/jsx.test.js`.
