# Découverte et configuration

`discoverProject({ rootDir, include?, exclude? })` lit les fichiers sans exécuter
l’application. Les mêmes règles s’appliquent à React/Vite et Next.js : aucun
dossier `src/`, `app/` ou `pages/` n’est imposé. Les fichiers JS, JSX, TS, TSX,
CSS, SCSS et Sass indenté sont reconnus, y compris `.module.css`, `.module.scss`
et `.module.sass`. Les extensions sont sensibles à la casse. Les contenus UTF-8
sont conservés tels quels, sans parsing ni compilation.

La configuration optionnelle est **`css-cleaner.config.json`**, uniquement à la
racine passée au scan. Aucun fichier JavaScript de configuration n’est exécuté.
Le contrat partagé v1 est conservé sans modification.

```json
{
  "include": ["src/**/*.{js,jsx,ts,tsx,css,scss,sass}", "app/**/*.{tsx,css,scss,sass}"],
  "exclude": ["**/*.test.*", "src/generated/"],
  "aliases": {
    "@/*": ["src/*", "app/*"],
    "@styles": "src/styles",
    "@theme": "src/styles/theme.css"
  },
  "externalGlobals": [
    "thirdParty",
    { "pattern": "vendor-*--active" }
  ]
}
```

- `include` vaut `**/*.{js,jsx,ts,tsx,css,scss,sass}` par défaut. Une liste vide
  ne sélectionne aucun fichier. L’option `include` de la fonction remplace celle
  du fichier. Les fichiers d’autres types restent ignorés, même avec `**/*`.
- `exclude` s’ajoute aux exclusions par défaut et aux options de la fonction.
  Les dépendances (`node_modules`, `.yarn`, `.pnpm`, `.pnpm-store`), le contrôle de
  version (`.git`, `.hg`, `.svn`) et les sorties (`.next`, `dist`, `build`, `out`,
  `coverage`, `.turbo`, `.cache`, `.vercel`, `.test-dist`) sont toujours exclus,
  à toute profondeur. Un répertoire exclu n’est pas parcouru.
- Les globs utilisent picomatch, incluent les chemins cachés comme `.storybook`,
  sont sensibles à la casse et relatifs à la racine. `/` et `\` sont normalisés
  en `/` ; les échappements par `\` ne sont donc pas disponibles. Un suffixe `/`
  signifie `/**`. Les chemins absolus, segments `..`, globs négatifs et délimiteurs
  déséquilibrés sont refusés. La configuration ne charge pas `.gitignore`.
- `aliases` associe un alias à un chemin ou une liste ordonnée de chemins de
  repli, relatifs à la racine. Les valeurs deviennent toujours des tableaux dans
  `ProjectConfig`. Un alias sans `*` accepte le nom exact ou un suffixe `/...` ;
  `@styles-extra` ne correspond pas à `@styles`. Un alias avec un unique `*`
  substitue sa capture dans le `*` éventuel de la cible. L’alias exact a priorité,
  puis le préfixe le plus long ; les égalités suivent `compareText`. Seul cet alias
  est retenu et ses cibles sont essayées dans l’ordre. `.` peut désigner la racine.
  Aucun alias de `tsconfig.json`, Vite ou Next.js n’est chargé implicitement.
- `externalGlobals` contient des noms exacts ou des objets `{ "pattern": "..." }`.
  Dans un motif, `*` accepte zéro ou plusieurs caractères d’un nom de classe ;
  tous les autres caractères sont littéraux. Ces motifs deviennent les fragments
  `literal`/`unknown` du contrat. Les chaînes représentent des noms exacts.
  La découverte transmet ces autorisations sans faire le rapprochement des classes.

Les options absentes donnent des alias et classes externes vides. Les clés
inconnues et valeurs mal typées sont refusées. `DiscoveryError` expose un `code`
stable, un message avec fichier/champ et une `location` si disponible. Une
configuration invalide utilise `invalid-config` et pointe sur la première ligne
de `css-cleaner.config.json` ; la CLI peut convertir cette erreur en `ScanOutcome`
fatal sans analyser le texte du message. Une erreur de lecture du fichier de
configuration, d’un répertoire ou d’une source est également fatale. Le fichier
de configuration doit être un fichier ordinaire, pas un lien symbolique.

`createStyleImportResolver(project)` est un service asynchrone fondé uniquement
sur le catalogue en mémoire. Il conserve le spécificateur, le binding et la
localisation de l’import. Les imports relatifs fonctionnent sans configuration ;
les alias utilisent les règles ci-dessus. Une cible explicite conserve sa portée
globale/module et son chemin relatif complet : deux `./Card.module.css` dans des
dossiers distincts restent deux identités.

Un import sans extension essaie `.css`, `.scss`, `.sass`, puis les trois variantes
`index.*`. `./Card.module` peut donc trouver `Card.module.scss`. Plusieurs fichiers
possibles produisent une référence `unknown` avec les candidats triés, sans choisir
arbitrairement une syntaxe. Les références absentes ou exclues conservent les
chemins essayés. Les imports hors racine, les paquets sans alias et les suffixes
de requête/fragment (`?inline`, `?url`, `#...`) restent inconnus avec une raison.
Le résolveur n’ajoute pas automatiquement `.module` à un nom sans extension.
Un spécificateur terminé par `/` essaie uniquement les fichiers `index.*`.

Les liens symboliques de sources/répertoires ne sont pas suivis, pour éviter les
cycles et les sources hors racine. Un avertissement `symlink-skipped`, affectant
la portée projet, garde cette limite visible pour le rapport. Les chemins,
collections de sources et avertissements suivent les conventions de tri v1,
indépendamment de l’ordre du système de fichiers et de la locale.

Les fixtures de `tests/discovery.test.ts` documentent ce format, la priorité des
options, les exclusions, les six styles, `src/` et `app/`, les erreurs, les liens
et la résolution avec un catalogue en mémoire. L’extraction JSX et l’assemblage
de la CLI restent aux étapes suivantes ; aucun réexport d’implémentation n’est
ajouté dans `src/index.ts`.
